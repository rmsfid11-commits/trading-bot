const { generateSignal } = require('../strategy/signals');
const { RiskManager } = require('../risk/manager');
const { logger } = require('../logger/trade-logger');
const { STRATEGY } = require('../config/strategy');
const { fetchTopVolumeSymbols } = require('../config/symbols');

const TAG = 'BOT';
const SYMBOL_REFRESH_INTERVAL = 3600000; // 1시간마다 종목 갱신

class TradingBot {
  constructor(exchange) {
    this.exchange = exchange;
    this.risk = new RiskManager();
    this.running = false;
    this.scanCount = 0;
    this.symbols = [];
    this.lastSignals = {};
    this.lastSymbolRefresh = Date.now();
    this.notifier = null; // main.js에서 주입
  }

  async start() {
    logger.info(TAG, '========== 트레이딩 봇 시작 ==========');

    // 업비트 거래량 상위 10종목 조회
    logger.info(TAG, '거래량 상위 10종목 조회 중...');
    const topSymbols = await fetchTopVolumeSymbols(10);
    this.symbols = topSymbols.map(s => s.symbol);
    this.lastSymbolRefresh = Date.now();
    logger.info(TAG, `감시 종목: ${this.symbols.join(', ')}`);
    logger.info(TAG, `전략: RSI(${STRATEGY.RSI_PERIOD}) ${STRATEGY.RSI_OVERSOLD}/${STRATEGY.RSI_OVERBOUGHT} | 볼밴(${STRATEGY.BOLLINGER_PERIOD},${STRATEGY.BOLLINGER_STD_DEV}) | 손절 ${STRATEGY.STOP_LOSS_PCT}% | 익절 ${STRATEGY.TAKE_PROFIT_PCT}%`);

    const connected = await this.exchange.connect();
    if (!connected) {
      logger.error(TAG, '거래소 연결 실패 - 봇 중지');
      return;
    }

    const balance = await this.exchange.getBalance();
    if (balance) {
      this.risk.setBalance(balance.free);
      logger.info(TAG, `잔고: ${balance.free.toLocaleString()}원`);
    }

    // 거래소 보유 코인 중 봇이 모르는 것 자동 입양
    await this.adoptOrphanedHoldings();

    this.running = true;
    this.loop();
  }

  async loop() {
    while (this.running) {
      try {
        this.scanCount++;
        await this.scan();
        await this.sleep(STRATEGY.SCAN_INTERVAL_MS);
      } catch (error) {
        logger.error(TAG, `루프 에러: ${error.message}`);
        await this.sleep(5000);
      }
    }
  }

  async adoptOrphanedHoldings() {
    const detailed = await this.exchange.getDetailedHoldings();
    if (!detailed) return;

    const positions = this.risk.getPositions();
    for (const [symbol, info] of Object.entries(detailed)) {
      if (positions[symbol]) continue; // 이미 추적 중
      if (info.quantity <= 0) continue;

      const amount = info.avgBuyPrice * info.quantity;
      if (amount < 1000) continue; // 너무 소액은 무시 (먼지)

      logger.warn(TAG, `고아 코인 발견 → 자동 입양: ${symbol} (${info.quantity}개, 평균매수가 ${info.avgBuyPrice.toLocaleString()}원)`);
      this.risk.openPosition(symbol, info.avgBuyPrice, info.quantity, Math.round(amount));

      // 감시 종목에 없으면 추가
      if (!this.symbols.includes(symbol)) {
        this.symbols.push(symbol);
        logger.info(TAG, `감시 종목에 추가: ${symbol}`);
      }
    }
  }

  async syncPositions() {
    const detailed = await this.exchange.getDetailedHoldings();
    if (!detailed) return;

    const positions = this.risk.getPositions();

    // 1. 봇에 있는데 거래소에 없는 것 → 외부 매도 감지
    for (const [symbol, pos] of Object.entries(positions)) {
      const held = detailed[symbol]?.quantity || 0;
      if (held < pos.quantity * 0.1) {
        logger.warn(TAG, `${symbol} 외부 매도 감지 (잔고: ${held}, 봇 기록: ${pos.quantity})`);
        this.risk.removePosition(symbol, '업비트에서 직접 매도됨');
        logger.logTrade({
          symbol, action: 'SELL', price: pos.entryPrice,
          quantity: pos.quantity, reason: '수동 매도 (업비트 앱)',
          pnl: null,
        });
      }
    }

    // 2. 거래소에 있는데 봇에 없는 것 → 고아 코인 입양
    await this.adoptOrphanedHoldings();
  }

  async refreshSymbols() {
    try {
      logger.info(TAG, '종목 자동 갱신 중...');
      const topSymbols = await fetchTopVolumeSymbols(10);
      const newSymbols = topSymbols.map(s => s.symbol);

      // 현재 열린 포지션이 있는 종목은 반드시 유지
      const positions = this.risk.getPositions();
      for (const sym of Object.keys(positions)) {
        if (!newSymbols.includes(sym)) {
          newSymbols.push(sym);
        }
      }

      const oldSymbols = [...this.symbols];
      this.symbols = newSymbols;
      this.lastSymbolRefresh = Date.now();

      const added = newSymbols.filter(s => !oldSymbols.includes(s));
      const removed = oldSymbols.filter(s => !newSymbols.includes(s));

      if (added.length > 0 || removed.length > 0) {
        logger.info(TAG, `종목 갱신 완료: +${added.length} -${removed.length}`);
        if (added.length > 0) logger.info(TAG, `  추가: ${added.join(', ')}`);
        if (removed.length > 0) logger.info(TAG, `  제거: ${removed.join(', ')}`);
      } else {
        logger.info(TAG, '종목 갱신 완료: 변경 없음');
      }

      logger.info(TAG, `감시 종목 (${this.symbols.length}): ${this.symbols.join(', ')}`);
    } catch (error) {
      logger.error(TAG, `종목 갱신 실패: ${error.message}`);
    }
  }

  async scan() {
    // 1시간마다 종목 자동 갱신
    if (Date.now() - this.lastSymbolRefresh > SYMBOL_REFRESH_INTERVAL) {
      await this.refreshSymbols();
    }

    // 5번째 스캔마다 거래소 잔고와 동기화
    if (this.scanCount % 5 === 0) {
      await this.syncPositions();
    }

    const positions = this.risk.getPositions();

    for (const symbol of this.symbols) {
      try {
        // 1. 기존 포지션 체크 (손절/익절)
        if (positions[symbol]) {
          const ticker = await this.exchange.getTicker(symbol);
          if (!ticker) continue;

          const check = this.risk.checkPosition(symbol, ticker.price);
          if (check) {
            await this.executeSell(symbol, positions[symbol], ticker.price, check.reason, check.pnlPct);
            continue;
          }
        }

        // 2. 새 시그널 분석
        const candles = await this.exchange.getCandles(symbol);
        if (!candles) continue;

        const signal = generateSignal(candles);
        this.lastSignals[symbol] = signal;
        this.logSignal(symbol, signal);

        // 3. 매수 실행
        if (signal.action === 'BUY' && !positions[symbol]) {
          await this.executeBuy(symbol, signal);
        }

        // 4. 매도 시그널
        if (signal.action === 'SELL' && positions[symbol]) {
          const ticker = await this.exchange.getTicker(symbol);
          if (ticker) {
            const pnlPct = ((ticker.price - positions[symbol].entryPrice) / positions[symbol].entryPrice) * 100;
            await this.executeSell(symbol, positions[symbol], ticker.price, signal.reasons.join(', '), pnlPct);
          }
        }
      } catch (error) {
        logger.error(TAG, `${symbol} 스캔 에러: ${error.message}`);
      }
    }

    // 10번째 스캔마다 상태 출력
    if (this.scanCount % 10 === 0) {
      this.printStatus();
    }
  }

  async executeBuy(symbol, signal) {
    const balance = await this.exchange.getBalance();
    if (!balance) return;

    const amount = Math.floor(balance.free * 0.18); // 계좌의 ~18%
    if (amount < 5000) {
      logger.warn(TAG, `매수 금액 부족: ${amount.toLocaleString()}원`);
      return;
    }

    const check = this.risk.canOpenPosition(symbol, amount, balance.free);
    if (!check.allowed) {
      logger.warn(TAG, `매수 불가 (${symbol}): ${check.reason}`);
      return;
    }

    const result = await this.exchange.buy(symbol, amount);
    if (result) {
      this.risk.openPosition(symbol, result.price, result.quantity, amount);
      logger.trade(TAG, `매수 체결: ${symbol}`, {
        price: result.price, quantity: result.quantity,
        amount, reason: signal.reasons.join(', '),
      });
      if (this.notifier) this.notifier.notifyTrade({ symbol, action: 'BUY', price: result.price, amount, reason: signal.reasons.join(', ') });
    }
  }

  async executeSell(symbol, position, currentPrice, reason, pnlPct) {
    // 실제 거래소 잔고 확인 → 보유량과 기록 중 작은 값으로 매도
    let sellQty = position.quantity;
    try {
      const holdings = await this.exchange.getHoldings();
      if (holdings) {
        const actual = holdings[symbol] || 0;
        if (actual < sellQty * 0.1) {
          logger.warn(TAG, `${symbol} 실제 잔고 거의 없음 (${actual}) → 포지션 제거`);
          this.risk.removePosition(symbol, '잔고 부족으로 포지션 정리');
          return;
        }
        if (actual < sellQty) {
          logger.info(TAG, `${symbol} 수량 보정: ${sellQty} → ${actual}`);
          sellQty = actual;
        }
      }
    } catch (e) { /* 조회 실패시 기존 수량으로 시도 */ }

    const result = await this.exchange.sell(symbol, sellQty);
    if (result) {
      const pnl = this.risk.closePosition(symbol, result.price);
      logger.logTrade({
        symbol, action: 'SELL', price: result.price,
        quantity: position.quantity, amount: position.amount,
        reason, pnl: pnlPct,
      });
      if (this.notifier) this.notifier.notifyTrade({ symbol, action: 'SELL', price: result.price, amount: position.amount, reason, pnl: pnlPct });
    }
  }

  logSignal(symbol, signal) {
    if (signal.action !== 'HOLD') {
      logger.info(TAG, `시그널 [${symbol}] ${signal.action}`, {
        reasons: signal.reasons,
        indicators: signal.indicators,
      });
    }
  }

  printStatus() {
    const positions = this.risk.getPositions();
    const posCount = Object.keys(positions).length;
    const dailyPnl = this.risk.getDailyPnl();

    logger.info(TAG, `--- 상태 (스캔 #${this.scanCount}) ---`);
    logger.info(TAG, `포지션: ${posCount}/5 | 일일 손익: ${dailyPnl >= 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}원`);

    for (const [sym, pos] of Object.entries(positions)) {
      const holdMin = Math.round((Date.now() - pos.entryTime) / 60000);
      logger.info(TAG, `  ${sym}: 진입 ${pos.entryPrice.toLocaleString()} | SL ${Math.round(pos.stopLoss).toLocaleString()} | TP ${Math.round(pos.takeProfit).toLocaleString()} | 최고 ${Math.round(pos.highestPrice || pos.entryPrice).toLocaleString()} | ${holdMin}분 보유`);
    }
  }

  async stop() {
    logger.info(TAG, '봇 정지 중...');
    this.running = false;

    // 모든 포지션 청산
    const positions = this.risk.getPositions();
    for (const [symbol, pos] of Object.entries(positions)) {
      logger.warn(TAG, `긴급 청산: ${symbol}`);
      const ticker = await this.exchange.getTicker(symbol);
      if (ticker) {
        await this.executeSell(symbol, pos, ticker.price, '긴급 정지', ((ticker.price - pos.entryPrice) / pos.entryPrice) * 100);
      }
    }

    logger.info(TAG, '========== 봇 종료 ==========');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TradingBot };
