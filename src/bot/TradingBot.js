const { generateSignal } = require('../strategy/signals');
const { RiskManager } = require('../risk/manager');
const { logger, createLogger } = require('../logger/trade-logger');
const { STRATEGY } = require('../config/strategy');
const { fetchTopVolumeSymbols } = require('../config/symbols');
const { runAnalysis, loadLearnedParams } = require('../learning/analyzer');
const { printReport } = require('../learning/reporter');
const { detectRegime, getRegimeAdjustments } = require('../learning/regime');
const { ContextualBandit } = require('../learning/bandit');
const { getSymbolWeightAdjustment, updateWeightsFromStats } = require('../learning/weights');
const { analyzeMultiTimeframe } = require('../indicators/multi-timeframe');
const { checkCorrelation } = require('../risk/correlation');
const { analyzeSentiment, loadSentiment, getSentimentBoost } = require('../sentiment/analyzer');
const { recordComboResult, getComboAdjustment, getOptimalMinBuyScore, getAllComboStats } = require('../learning/combo-tracker');
const { runBacktest, loadBacktestResults } = require('../learning/backtest');
const { analyzeOrderbook } = require('../indicators/orderbook');
const { calculateKimchiPremium, getKimchiPremiumAlert } = require('../indicators/kimchi-premium');
const { calculateATR } = require('../indicators/atr');
const { TelegramBot } = require('../notification/telegram');
const { mergeAllTrades } = require('../learning/merger');
const { GridTrader } = require('../strategy/grid');
const { fetchWhaleAlerts, getWhaleSignal } = require('../indicators/whale-alert');
const { calculateBreakoutSignal } = require('../strategy/volatility-breakout');
const { autoTune, shouldAutoTune } = require('../learning/auto-tune');

const TAG = 'BOT';
const SYMBOL_REFRESH_INTERVAL = 3600000; // 1시간마다 종목 갱신
const LEARNING_TRADE_INTERVAL = 50; // 50거래마다 학습

class TradingBot {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.userId = options.userId || null;
    this.logDir = options.logDir || null;
    // 유저별 로거 (logDir이 있으면 유저별 trades.jsonl에 기록)
    this.logger = this.logDir ? createLogger(this.logDir, this.userId || '') : logger;
    this.risk = new RiskManager(this.logDir);
    this.running = false;
    this.scanCount = 0;
    this.symbols = [];
    this.lastSignals = {};
    this.lastSymbolRefresh = Date.now();
    this.notifier = null; // main.js에서 주입

    // 학습 모듈
    this.learnedData = loadLearnedParams(this.logDir);
    this.lastLearnDate = null;
    this.tradeCountSinceLearn = 0;

    // 레짐 & 밴딧
    this.currentRegime = { regime: 'unknown', confidence: 0, indicators: {} };
    this.bandit = new ContextualBandit(this.logDir);
    this.lastRegimeUpdate = 0;

    // 매매별 사용 프로필 기록 (밴딧 업데이트용)
    this.tradeProfiles = {}; // symbol → { profile, regime, hour }

    // 멀티 타임프레임 캐시
    this.mtfCandles = {}; // symbol → { '1h': candles, '4h': candles }
    this.lastMtfUpdate = {}; // symbol → timestamp
    this.MTF_UPDATE_INTERVAL = 600000; // 10분마다 MTF 캔들 갱신

    // 상관관계 캐시
    this.candlesCache = {}; // symbol → 5m candles (signal용 캐시)

    // 감성 분석
    this.sentiment = loadSentiment(this.logDir); // 저장된 감성 데이터 로드
    this.lastSentimentUpdate = 0;
    this.SENTIMENT_UPDATE_INTERVAL = 900000; // 15분마다 감성 분석

    // 콤보 트래커 & 동적 매수 기준
    this.comboMinBuyScore = getOptimalMinBuyScore(this.logDir);
    this.lastBacktestResult = loadBacktestResults(this.logDir);

    // 호가창 + 김프
    this.orderbookCache = {}; // symbol → { score, data, time }
    this.kimchiPremium = null;
    this.lastKimchiUpdate = 0;
    this.KIMCHI_UPDATE_INTERVAL = 300000; // 5분마다

    // 고래 알림
    this.lastWhaleUpdate = 0;
    this.WHALE_UPDATE_INTERVAL = 300000; // 5분마다

    // 김프 알림 (종목별)
    this.kimchiAlerts = []; // 최근 김프 알림 배열

    // 확인 캔들 필터: 대기 중인 시그널
    this.pendingSignals = {}; // symbol → { signal, mtf, candle, time }

    // 텔레그램 봇 (멀티유저: options.telegramConfig로 유저별 토큰/chatId 전달)
    this.telegram = new TelegramBot(this, options.telegramConfig || null);

    // 그리드 트레이딩
    this.grid = new GridTrader(this.logDir);
  }

  async start() {
    const userTag = this.userId ? ` [${this.userId}]` : '';
    logger.info(TAG, `==========${userTag} 트레이딩 봇 시작 ==========`);

    // 업비트 거래량 상위 20종목 조회
    logger.info(TAG, '거래량 상위 20종목 조회 중...');
    const topSymbols = await fetchTopVolumeSymbols(20);
    this.symbols = topSymbols.map(s => s.symbol);
    this.lastSymbolRefresh = Date.now();
    logger.info(TAG, `감시 종목: ${this.symbols.join(', ')}`);
    logger.info(TAG, `전략: RSI(${STRATEGY.RSI_PERIOD}) ${STRATEGY.RSI_OVERSOLD}/${STRATEGY.RSI_OVERBOUGHT} | 볼밴(${STRATEGY.BOLLINGER_PERIOD},${STRATEGY.BOLLINGER_STD_DEV}) | 손절 ${STRATEGY.STOP_LOSS_PCT}% | 익절 ${STRATEGY.TAKE_PROFIT_PCT}%`);

    // 학습 데이터 로드 로그
    if (this.learnedData) {
      const bl = this.learnedData.blacklist || [];
      if (bl.length > 0) logger.info(TAG, `블랙리스트: ${bl.join(', ')}`);
      const ph = this.learnedData.preferredHours || [];
      if (ph.length > 0) logger.info(TAG, `선호 시간대: ${ph.map(h => h + '시').join(', ')}`);
      const ah = this.learnedData.avoidHours || [];
      if (ah.length > 0) logger.info(TAG, `비선호 시간대: ${ah.map(h => h + '시').join(', ')}`);
    }

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

    // 텔레그램 봇 시작
    this.telegram.start();

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
      if (positions[symbol]) continue;
      if (info.quantity <= 0) continue;

      const amount = info.avgBuyPrice * info.quantity;
      if (amount < 1000) continue;

      logger.warn(TAG, `고아 코인 발견 → 자동 입양: ${symbol} (${info.quantity}개, 평균매수가 ${info.avgBuyPrice.toLocaleString()}원)`);
      this.risk.openPosition(symbol, info.avgBuyPrice, info.quantity, Math.round(amount));

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

    for (const [symbol, pos] of Object.entries(positions)) {
      const held = detailed[symbol]?.quantity || 0;
      if (held < pos.quantity * 0.1) {
        logger.warn(TAG, `${symbol} 외부 매도 감지 (잔고: ${held}, 봇 기록: ${pos.quantity})`);
        this.risk.removePosition(symbol, '업비트에서 직접 매도됨');
        this.logger.logTrade({
          symbol, action: 'SELL', price: pos.entryPrice,
          quantity: pos.quantity, reason: '수동 매도 (업비트 앱)',
          pnl: null,
        });
      }
    }

    await this.adoptOrphanedHoldings();
  }

  async refreshSymbols() {
    try {
      logger.info(TAG, '종목 자동 갱신 중...');
      const topSymbols = await fetchTopVolumeSymbols(20);
      const newSymbols = topSymbols.map(s => s.symbol);

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

  // ─── 레짐 감지 (30스캔마다, ~5분) ───

  async updateRegime() {
    if (Date.now() - this.lastRegimeUpdate < 300000) return; // 5분 간격

    try {
      // 대표 종목(BTC)으로 시장 레짐 판단
      const btcSymbol = this.symbols.find(s => s.startsWith('BTC/')) || this.symbols[0];
      if (!btcSymbol) return;

      const candles = await this.exchange.getCandles(btcSymbol);
      if (!candles) return;

      const prevRegime = this.currentRegime.regime;
      this.currentRegime = detectRegime(candles);
      this.lastRegimeUpdate = Date.now();

      if (prevRegime !== this.currentRegime.regime) {
        const adj = getRegimeAdjustments(this.currentRegime.regime);
        logger.info(TAG, `시장 레짐 변경: ${prevRegime} → ${this.currentRegime.regime} (신뢰도 ${(this.currentRegime.confidence * 100).toFixed(0)}%) | ADX ${this.currentRegime.indicators.adx} ATR ${this.currentRegime.indicators.atrPct}%`);
      }
    } catch (error) {
      logger.error(TAG, `레짐 감지 실패: ${error.message}`);
    }
  }

  // ─── 감성 분석 업데이트 ───

  async updateSentiment() {
    if (Date.now() - this.lastSentimentUpdate < this.SENTIMENT_UPDATE_INTERVAL) return;

    try {
      this.sentiment = await analyzeSentiment(this.symbols, this.logDir);
      this.lastSentimentUpdate = Date.now();

      const s = this.sentiment.overall;
      const fg = this.sentiment.fearGreed;
      logger.info(TAG, `감성 분석 갱신: 종합 ${s.score}(${s.signal}) | F&G ${fg.value}(${fg.label}) | Reddit ${this.sentiment.reddit.score} | 뉴스 ${this.sentiment.news.score}`);

      // 버즈 알림
      if (this.sentiment.buzz?.length > 0) {
        for (const b of this.sentiment.buzz) {
          logger.warn(TAG, `🔥 버즈 감지: ${b.symbol} (${b.mentions}건 멘션, 감성 ${b.sentiment > 0 ? '긍정' : '부정'})`);
        }
      }
    } catch (error) {
      logger.error(TAG, `감성 분석 실패: ${error.message}`);
    }
  }

  // ─── 김프 업데이트 ───

  async updateKimchiPremium() {
    if (Date.now() - this.lastKimchiUpdate < this.KIMCHI_UPDATE_INTERVAL) return;
    try {
      // 현재 가격 수집
      const prices = {};
      for (const sym of this.symbols.slice(0, 5)) {
        const ticker = await this.exchange.getTicker(sym);
        if (ticker) prices[sym] = ticker.price;
      }
      if (Object.keys(prices).length === 0) return;

      this.kimchiPremium = await calculateKimchiPremium(prices);
      this.lastKimchiUpdate = Date.now();

      if (this.kimchiPremium.avgPremium !== 0) {
        logger.info(TAG, `김프: ${this.kimchiPremium.avgPremium}% (${this.kimchiPremium.signal}) | 환율: ${this.kimchiPremium.exRate}`);
      }

      // 김프 알림 체크 (종목별 과열/역프)
      this.kimchiAlerts = await getKimchiPremiumAlert(this.symbols, prices);
      if (this.kimchiAlerts.length > 0) {
        for (const alert of this.kimchiAlerts) {
          logger.warn(TAG, `김프 알림: ${alert.symbol} — ${alert.alert}`);
        }
      }
    } catch (error) {
      logger.error(TAG, `김프 업데이트 실패: ${error.message}`);
    }
  }

  // ─── 고래 알림 업데이트 ───

  async updateWhaleAlerts() {
    if (Date.now() - this.lastWhaleUpdate < this.WHALE_UPDATE_INTERVAL) return;

    try {
      const alerts = await fetchWhaleAlerts();
      this.lastWhaleUpdate = Date.now();

      if (alerts && alerts.length > 0) {
        const inflows = alerts.filter(a => a.isExchangeInflow).length;
        const outflows = alerts.filter(a => a.isExchangeOutflow).length;
        logger.info(TAG, `고래 알림 갱신: ${alerts.length}건 (거래소유입 ${inflows}, 유출 ${outflows})`);
      }
    } catch (error) {
      logger.error(TAG, `고래 알림 업데이트 실패: ${error.message}`);
    }
  }

  // ─── 호가창 분석 ───

  async getOrderbookScore(symbol) {
    const cached = this.orderbookCache[symbol];
    if (cached && Date.now() - cached.time < 30000) return cached; // 30초 캐시

    try {
      const ob = await this.exchange.exchange.fetchOrderBook(symbol, 15);
      const ticker = await this.exchange.getTicker(symbol);
      if (!ob || !ticker) return { score: 0, data: null };

      const result = analyzeOrderbook(ob, ticker.price);
      this.orderbookCache[symbol] = { ...result, time: Date.now() };
      return result;
    } catch {
      return { score: 0, data: null };
    }
  }

  // ─── 멀티 타임프레임 캔들 업데이트 ───

  async updateMTFCandles(symbol) {
    const now = Date.now();
    const lastUpdate = this.lastMtfUpdate[symbol] || 0;
    if (now - lastUpdate < this.MTF_UPDATE_INTERVAL) return;

    try {
      const [candles1h, candles4h] = await Promise.all([
        this.exchange.getCandles(symbol, '1h', 100),
        this.exchange.getCandles(symbol, '4h', 60),
      ]);

      if (!this.mtfCandles[symbol]) this.mtfCandles[symbol] = {};
      if (candles1h) this.mtfCandles[symbol]['1h'] = candles1h;
      if (candles4h) this.mtfCandles[symbol]['4h'] = candles4h;
      this.lastMtfUpdate[symbol] = now;
    } catch (error) {
      logger.error(TAG, `MTF 캔들 업데이트 실패 (${symbol}): ${error.message}`);
    }
  }

  /**
   * 멀티 타임프레임 분석 결과 가져오기
   */
  getMTFResult(symbol, candles5m) {
    const mtfData = { '5m': candles5m };
    if (this.mtfCandles[symbol]?.['1h']) mtfData['1h'] = this.mtfCandles[symbol]['1h'];
    if (this.mtfCandles[symbol]?.['4h']) mtfData['4h'] = this.mtfCandles[symbol]['4h'];
    return analyzeMultiTimeframe(mtfData);
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

    // 잔고 업데이트 → 드로다운 트래커
    if (this.scanCount % 3 === 0) {
      const balance = await this.exchange.getBalance();
      if (balance) this.risk.drawdownTracker.updateBalance(balance.free);
    }

    // 레짐 감지
    await this.updateRegime();

    // 감성 분석 (15분마다)
    await this.updateSentiment();

    // 김프 업데이트 (5분마다)
    await this.updateKimchiPremium();

    // 고래 알림 업데이트 (5분마다)
    await this.updateWhaleAlerts();

    // 자동 학습: 매일 자정 또는 50거래마다
    await this.checkAutoLearn();

    const positions = this.risk.getPositions();
    const regime = this.currentRegime.regime;
    const regimeAdj = getRegimeAdjustments(regime);

    for (const symbol of this.symbols) {
      try {
        // MTF 캔들 업데이트 (10분마다)
        await this.updateMTFCandles(symbol);

        // 0. 기존 포지션 분할매도 체크
        if (positions[symbol]) {
          const ticker = await this.exchange.getTicker(symbol);
          if (!ticker) continue;

          // RSI를 포지션에 전달 (휩쏘 과매도 보호용)
          const cachedCandles = this.candlesCache[symbol];
          if (cachedCandles && cachedCandles.length > 15) {
            const { calculateRSI } = require('../indicators/rsi');
            const closes = cachedCandles.map(c => c.close);
            const currentRsi = calculateRSI(closes);
            const pos = this.risk.positions.get(symbol);
            if (pos && currentRsi != null) pos.lastRsi = currentRsi;
          }

          // 분할매도 체크
          const partial = this.risk.checkPartialExit(symbol, ticker.price);
          if (partial) {
            await this.executePartialSell(symbol, positions[symbol], ticker.price, partial);
            // 전량 매도가 아니면 다음 시그널도 체크
            if (partial.fraction < 1.0) {
              // 포지션이 아직 남아있으면 손절/익절 체크 계속
            } else {
              continue;
            }
          }

          // 1. 기존 포지션 체크 (손절/익절)
          const check = this.risk.checkPosition(symbol, ticker.price);
          if (check) {
            await this.executeSell(symbol, positions[symbol], ticker.price, check.reason, check.pnlPct);
            continue;
          }

          // DCA (물타기) 체크 — RSI 과매도 확인 후 조건부 실행
          if (STRATEGY.DCA_ENABLED) {
            // 캐시된 캔들에서 RSI 가져오기
            let dcaRsi = null;
            const dcaCandles = this.candlesCache[symbol];
            if (dcaCandles && dcaCandles.length > 15) {
              const { calculateRSI } = require('../indicators/rsi');
              dcaRsi = calculateRSI(dcaCandles.map(c => c.close));
            }
            const dcaCheck = this.risk.canDCA(symbol, ticker.price, dcaRsi);
            if (dcaCheck.allowed) {
              logger.info(TAG, `${symbol} DCA 조건 충족: ${dcaCheck.reason}`);
              await this.executeDCA(symbol, positions[symbol], ticker.price);
            }
          }

          continue; // 포지션이 있으면 매수 시그널 스킵
        }

        // 2. 새 시그널 분석 (종목별 가중치 + 레짐 + MTF 반영)
        const candles = await this.exchange.getCandles(symbol);
        if (!candles) continue;
        this.candlesCache[symbol] = candles; // 상관관계용 캐시

        // MTF 분석
        const mtf = this.getMTFResult(symbol, candles);

        // 감성 분석 부스트
        const sentBoost = getSentimentBoost(symbol, this.sentiment);

        // 호가창 분석 (5번째 스캔마다)
        let obScore = 0;
        if (this.scanCount % 5 === 0) {
          const ob = await this.getOrderbookScore(symbol);
          obScore = ob.score || 0;
        } else {
          obScore = this.orderbookCache[symbol]?.score || 0;
        }

        // 김프 부스트 (전체 평균)
        let kimchiBuy = this.kimchiPremium?.buyBoost || 0;
        let kimchiSell = this.kimchiPremium?.sellBoost || 0;

        // 김프 종목별 알림 부스트
        const symbolKimchiAlert = this.kimchiAlerts.find(a => a.symbol === symbol);
        if (symbolKimchiAlert) {
          if (symbolKimchiAlert.premium > 5) {
            kimchiSell += 0.5;
          } else if (symbolKimchiAlert.premium < -2) {
            kimchiBuy += 0.5;
          }
        }

        // 고래 알림 부스트
        const whaleSignal = getWhaleSignal(symbol);
        const whaleBuy = whaleSignal.buyBoost || 0;
        const whaleSell = whaleSignal.sellBoost || 0;

        const symbolScore = this.learnedData?.symbolScores?.[symbol];
        const buyThresholdMult = getSymbolWeightAdjustment(symbol, this.learnedData?.analysis?.bySymbol)
          * regimeAdj.BUY_THRESHOLD_MULT;

        // 콤보 기반 동적 매수 기준 적용
        const dynamicMinScore = this.comboMinBuyScore?.minBuyScore || 2.0;

        // F&G 기반 동적 매수 임계값: 공포=매수 기회, 탐욕=신중
        const fgVal = this.sentiment?.fearGreed?.value ?? 50;
        let fgMult = 1.0;
        if (fgVal < 15) fgMult = 0.9;       // 극단 공포: 오히려 매수 기회 (역발상)
        else if (fgVal < 25) fgMult = 1.0;  // 공포: 기본 유지
        else if (fgVal < 40) fgMult = 1.0;  // 약한 공포: 기본 유지
        else if (fgVal > 75) fgMult = 1.2;  // 탐욕: 기준 상향 (고점 매수 방지)

        const effectiveBuyMult = buyThresholdMult * (dynamicMinScore / 2.0) * fgMult;

        const signal = generateSignal(candles, {
          regime,
          symbolScore,
          buyThresholdMult: effectiveBuyMult,
          mtfBoost: mtf.boost,
          mtfSignal: mtf.signal,
          sentimentBuyBoost: sentBoost.buyBoost + whaleBuy,
          sentimentSellBoost: sentBoost.sellBoost + whaleSell,
          orderbookScore: obScore,
          kimchiBuyBoost: kimchiBuy,
          kimchiSellBoost: kimchiSell,
        });

        // 변동성 돌파 전략 시그널 (추가 시그널 소스)
        const breakoutResult = calculateBreakoutSignal(candles, 0.5);
        if (breakoutResult.signal === 'buy') {
          if (signal.action === 'BUY') {
            // 메인 시그널 BUY + 돌파 BUY → 점수 부스트 +1.0
            signal.scores.buy += 1.0;
            signal.reasons.push(`변동성 돌파 (K=${breakoutResult.k}, 목표가 ${breakoutResult.breakoutPrice.toLocaleString()})`);
          } else if (signal.action === 'HOLD') {
            // 메인 시그널 중립이지만 돌파 BUY → 점수 3.0으로 매수 가능
            const breakoutMinScore = 3.0;
            if (breakoutResult.strength >= 0.5) {
              signal.scores.buy = breakoutMinScore;
              signal.action = 'BUY';
              signal.reasons.push(`변동성 돌파 (K=${breakoutResult.k}, 목표가 ${breakoutResult.breakoutPrice.toLocaleString()})`);
            }
          }
        } else if (breakoutResult.signal === 'sell') {
          signal.scores.sell += breakoutResult.strength;
          signal.reasons.push(`변동성 하락돌파 (K=${breakoutResult.k}, 목표가 ${breakoutResult.breakdownPrice.toLocaleString()})`);
        }

        // 김프 종목별 알림을 시그널 이유에 추가
        if (symbolKimchiAlert) {
          if (symbolKimchiAlert.premium > 5) {
            signal.reasons.push(`김프 과열 +${symbolKimchiAlert.premium}%`);
          } else if (symbolKimchiAlert.premium < -2) {
            signal.reasons.push(`역프 ${symbolKimchiAlert.premium}%`);
          }
        }

        this.lastSignals[symbol] = { ...signal, mtf, sentiment: sentBoost, orderbook: obScore, kimchi: this.kimchiPremium, whale: whaleSignal, breakout: breakoutResult };
        this.logSignal(symbol, signal);

        // 3. 매수 실행 (확인 캔들 필터 → 상관관계 + MTF + 콤보 체크)
        if (signal.action === 'BUY') {
          const buyScore = signal.scores?.buy || 0;

          // 강한 시그널(4점 이상)은 확인 캔들 없이 즉시 매수
          if (buyScore >= 4) {
            logger.info(TAG, `${symbol} 강한 매수 시그널 (${buyScore.toFixed(1)}점) → 즉시 매수`);
            delete this.pendingSignals[symbol];
            await this.executeBuy(symbol, signal, mtf);
          } else {
            // 보통 시그널: 확인 캔들 필터
            const pending = this.pendingSignals[symbol];
            if (pending && Date.now() - pending.time < 600000) {
              const lastCandle = candles[candles.length - 1];
              const isGreenCandle = lastCandle.close > lastCandle.open;
              // 음봉이어도 하락폭 -0.3% 이내면 허용 (거의 보합)
              const candleChange = (lastCandle.close - lastCandle.open) / lastCandle.open * 100;
              if (isGreenCandle || candleChange > -0.3) {
                delete this.pendingSignals[symbol];
                await this.executeBuy(symbol, signal, mtf);
              } else {
                delete this.pendingSignals[symbol];
                logger.info(TAG, `${symbol} 확인 캔들 음봉 (${candleChange.toFixed(2)}%) → 매수 취소`);
              }
            } else {
              this.pendingSignals[symbol] = { signal, mtf, time: Date.now() };
              logger.info(TAG, `${symbol} 매수 시그널 대기 (${buyScore.toFixed(1)}점, 다음 캔들 확인 중)`);
            }
          }
        } else {
          // BUY가 아닌 경우 대기 시그널 정리
          if (this.pendingSignals[symbol]) {
            delete this.pendingSignals[symbol];
          }
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

    // 6. 그리드 트레이딩 (횡보장 전용)
    if (STRATEGY.GRID_ENABLED && (!STRATEGY.GRID_REGIME_ONLY || this.currentRegime?.regime === 'ranging')) {
      await this.checkGridTrades();
    } else if (STRATEGY.GRID_ENABLED && STRATEGY.GRID_REGIME_ONLY && this.currentRegime?.regime !== 'ranging') {
      // 레짐이 ranging이 아니면 기존 그리드 리셋
      const gridStatus = this.grid.getGridStatus();
      const activeSymbols = Object.keys(gridStatus.activeGrids);
      if (activeSymbols.length > 0) {
        for (const sym of activeSymbols) {
          const resetResult = this.grid.resetGrid(sym);
          if (resetResult.hadFilledBuys) {
            logger.warn(TAG, `그리드 리셋 (${sym}): 레짐 ${this.currentRegime?.regime} → 미체결 매수 ${resetResult.filledBuys.length}건 남음`);
          } else {
            logger.info(TAG, `그리드 리셋 (${sym}): 레짐 ${this.currentRegime?.regime}`);
          }
        }
      }
    }

    // 10번째 스캔마다 상태 출력
    if (this.scanCount % 10 === 0) {
      this.printStatus();
    }
  }

  // ─── 확률 기반 포지션 사이징 ───

  calcPositionSize(symbol, signal, balance) {
    const basePositionPct = (STRATEGY.BASE_POSITION_PCT || 12) / 100;
    let basePct = basePositionPct; // 기본 12%

    // 1. 시그널 강도에 따라 조절
    const buyScore = signal.scores?.buy || 0;
    if (buyScore >= 5) basePct *= 1.2;        // 강한 시그널 +20%
    else if (buyScore >= 3.5) basePct *= 1.1;  // 보통+ +10%
    else if (buyScore < 2.5) basePct *= 0.85;  // 약한 시그널 -15%

    // 2. 종목 학습 점수에 따라 조절
    const score = this.learnedData?.symbolScores?.[symbol];
    if (score != null) {
      if (score >= 70) basePct += 0.02;      // 좋은 종목 +2%
      else if (score < 40) basePct -= 0.02;  // 나쁜 종목 -2%
    }

    // 3. 선호 시간대 보너스
    const hour = new Date().getHours();
    if (this.learnedData?.preferredHours?.includes(hour)) {
      basePct += 0.01;
    }

    // 4. 레짐 보정
    const regime = this.currentRegime.regime;
    if (regime === 'volatile') basePct *= 0.6;  // 급변장: 40% 축소
    if (regime === 'trending') basePct *= 1.1;  // 추세장: 10% 확대

    // 5. ATR 기반 변동성 보정 (핵심 개선!)
    const candles = this.candlesCache[symbol];
    if (candles && candles.length > 15) {
      const atrData = calculateATR(candles);
      if (atrData) {
        // 변동성이 높으면 포지션 축소, 낮으면 확대
        // 기준: ATR 1% = 보통, 2%+ = 위험, 0.5% = 안정
        if (atrData.atrPct >= 3.0) basePct *= 0.5;       // 매우 높은 변동성
        else if (atrData.atrPct >= 2.0) basePct *= 0.65;  // 높은 변동성
        else if (atrData.atrPct >= 1.5) basePct *= 0.8;   // 보통+ 변동성
        else if (atrData.atrPct < 0.5) basePct *= 1.15;   // 안정적
      }
    }

    // 6. 드로다운 기반 축소
    const sizingMult = this.risk.getSizingMultiplier();
    basePct *= sizingMult;

    // 바운드: 10% ~ 30% (소액계좌 집중 투자)
    basePct = Math.max(0.10, Math.min(0.30, basePct));

    return Math.floor(balance * basePct);
  }

  async executeBuy(symbol, signal, mtf) {
    // 블랙리스트 종목 회피
    if (this.learnedData?.blacklist?.includes(symbol)) {
      logger.info(TAG, `${symbol} 블랙리스트 종목 → 매수 스킵`);
      return;
    }

    // F&G 로그만 (차단 제거 — fgMult로 이미 기준 조절됨)
    const fgValue = this.sentiment?.fearGreed?.value;
    if (fgValue != null && fgValue < 20) {
      logger.info(TAG, `${symbol} F&G 공포 (${fgValue}) — 매수 기준 상향 적용 중`);
    }

    // 비선호 시간대 매수 억제
    const currentHour = new Date().getHours();
    if (this.learnedData?.avoidHours?.includes(currentHour)) {
      logger.info(TAG, `${symbol} 비선호 시간대(${currentHour}시) → 매수 스킵`);
      return;
    }

    // 상관관계 체크: 보유 종목과 높은 상관관계면 매수 스킵
    const positions = this.risk.getPositions();
    const heldSymbols = Object.keys(positions);
    if (heldSymbols.length > 0 && Object.keys(this.candlesCache).length > 0) {
      const corrResult = checkCorrelation(this.candlesCache, symbol, heldSymbols, 0.7);
      if (!corrResult.allowed) {
        const corrPairs = corrResult.highCorr.map(c => `${c.symbol.replace('/KRW', '')}(${c.correlation})`).join(', ');
        logger.info(TAG, `${symbol} 상관관계 높음 → 매수 스킵 (${corrPairs})`);
        return;
      }
    }

    // MTF 반대 방향이면 매수 억제
    if (mtf && mtf.signal === 'strong_sell') {
      logger.info(TAG, `${symbol} MTF 강한 매도 → 매수 스킵`);
      return;
    }

    const balance = await this.exchange.getBalance();
    if (!balance) return;

    // 확률 기반 포지션 사이징
    const amount = this.calcPositionSize(symbol, signal, balance.free);
    if (amount < 5000) {
      logger.warn(TAG, `매수 금액 부족: ${amount.toLocaleString()}원`);
      return;
    }

    const check = this.risk.canOpenPosition(symbol, amount, balance.free);
    if (!check.allowed) {
      logger.warn(TAG, `매수 불가 (${symbol}): ${check.reason}`);
      return;
    }

    // 밴딧: 현재 컨텍스트에서 최적 프로필 선택
    const regime = this.currentRegime.regime;
    const banditChoice = this.bandit.selectProfile(regime, currentHour);

    // 콤보 체크: 시그널 조합의 과거 승률로 매수 억제/촉진
    const comboAdj = getComboAdjustment(signal.reasons.join(', '), this.logDir);
    if (comboAdj.block) {
      logger.info(TAG, `${symbol} 콤보 차단: ${comboAdj.comboKey} (승률 ${comboAdj.winRate}%, ${comboAdj.trades}거래)`);
      return;
    }

    // 지정가 매수 시도 → 실패/타임아웃 시 시장가 폴백 (buyLimit 내부 처리)
    const targetPrice = signal.snapshot?.price || signal.indicators?.price || null;
    let result = null;
    let orderTypeUsed = 'market';

    if (targetPrice && targetPrice > 0) {
      logger.info(TAG, `${symbol} 지정가 매수 시도 (목표가 ${Math.round(targetPrice).toLocaleString()}원)`);
      result = await this.exchange.buyLimit(symbol, amount, targetPrice);
      if (result) {
        orderTypeUsed = result.orderType || 'limit';
      }
    }

    // 지정가 실패 또는 목표가 없는 경우 시장가 매수
    if (!result) {
      logger.info(TAG, `${symbol} 시장가 매수 실행`);
      result = await this.exchange.buy(symbol, amount);
      orderTypeUsed = 'market';
    }

    if (result) {
      logger.info(TAG, `${symbol} 매수 체결 (${orderTypeUsed === 'limit' ? '지정가' : orderTypeUsed === 'market_fallback' ? '시장가 폴백' : '시장가'})`);

      // ATR 동적 SL/TP: 캔들 데이터 전달
      const candles = this.candlesCache[symbol] || null;
      this.risk.openPosition(symbol, result.price, result.quantity, amount, candles);
      this.tradeCountSinceLearn++;

      // 밴딧 프로필 기록
      this.tradeProfiles[symbol] = {
        profile: banditChoice.profile,
        regime,
        hour: currentHour,
      };

      // 콤보 추적용: 매수 이유와 스냅샷을 포지션에 기록
      const pos = this.risk.positions.get(symbol);
      if (pos) {
        pos.buyReason = signal.reasons.join(', ');
        pos.buySnapshot = signal.snapshot || {};
        pos.comboKey = comboAdj.comboKey;
      }

      // 스냅샷 포함 거래 로그
      this.logger.logTrade({
        symbol, action: 'BUY', price: result.price,
        quantity: result.quantity, amount,
        reason: signal.reasons.join(', '),
        pnl: null,
        snapshot: signal.snapshot || null,
        regime,
        banditProfile: banditChoice.profile,
        mtfSignal: mtf?.signal || 'neutral',
        orderType: orderTypeUsed,
      });

      logger.trade(TAG, `매수 체결: ${symbol} [${regime}/${banditChoice.profile}] MTF:${mtf?.signal || '-'} 주문:${orderTypeUsed}`, {
        price: result.price, quantity: result.quantity,
        amount, reason: signal.reasons.join(', '),
        buyScore: signal.scores?.buy,
        orderType: orderTypeUsed,
      });
      if (this.notifier) this.notifier.notifyTrade({ symbol, action: 'BUY', price: result.price, amount, reason: signal.reasons.join(', ') });
      this.telegram.notifyTrade({ symbol, action: 'BUY', price: result.price, amount, reason: signal.reasons.join(', ') });
    }
  }

  async executeSell(symbol, position, currentPrice, reason, pnlPct) {
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
      this.tradeCountSinceLearn++;

      // 밴딧 업데이트: 매도 시 수익률로 해당 프로필 보상
      const tradeProfile = this.tradeProfiles[symbol];
      if (tradeProfile && pnlPct != null) {
        this.bandit.update(tradeProfile.regime, tradeProfile.hour, tradeProfile.profile, pnlPct);
        delete this.tradeProfiles[symbol];
      }

      // 콤보 트래커: 매수 이유 + 수익률 기록
      if (pnlPct != null) {
        const buyReason = position.buyReason || reason;
        const snapshot = position.buySnapshot || {};
        recordComboResult(buyReason, pnlPct, snapshot, this.logDir);
      }

      this.logger.logTrade({
        symbol, action: 'SELL', price: result.price,
        quantity: position.quantity, amount: position.amount,
        reason, pnl: pnlPct,
      });
      if (this.notifier) this.notifier.notifyTrade({ symbol, action: 'SELL', price: result.price, amount: position.amount, reason, pnl: pnlPct });
      this.telegram.notifyTrade({ symbol, action: 'SELL', price: result.price, amount: position.amount, reason, pnl: pnlPct });
    } else {
      // 매도 실패 처리: 연속 실패 시 강제 포지션 정리
      logger.warn(TAG, `${symbol} 매도 실패 (${reason})`);
      const forceRemoved = this.risk.recordSellFailure(symbol);
      if (forceRemoved) {
        this.telegram.notifyTrade({ symbol, action: 'FORCE_REMOVE', price: currentPrice, reason: '매도 10회 연속 실패 → 수동 확인 필요' });
      }
    }
  }

  // ─── 분할매도 ───

  async executePartialSell(symbol, position, currentPrice, partialInfo) {
    let sellQty = Math.floor(position.quantity * partialInfo.fraction * 1e8) / 1e8;

    try {
      const holdings = await this.exchange.getHoldings();
      if (holdings) {
        const actual = holdings[symbol] || 0;
        if (actual < sellQty) sellQty = actual;
        if (sellQty < actual * 0.05) {
          logger.info(TAG, `${symbol} 분할매도 수량 너무 적음 → 스킵`);
          return;
        }
      }
    } catch { /* ignore */ }

    const result = await this.exchange.sell(symbol, sellQty);
    if (result) {
      const partialResult = this.risk.partialClose(symbol, partialInfo.fraction, currentPrice);

      this.logger.logTrade({
        symbol, action: 'PARTIAL_SELL', price: currentPrice,
        quantity: sellQty, amount: Math.round(currentPrice * sellQty),
        reason: partialInfo.reason,
        pnl: partialInfo.pnlPct,
      });

      logger.trade(TAG, `분할매도: ${symbol} (${Math.round(partialInfo.fraction * 100)}%)`, {
        price: currentPrice, soldQty: sellQty,
        reason: partialInfo.reason, pnlPct: partialInfo.pnlPct?.toFixed(2),
      });

      if (this.notifier) {
        this.notifier.notifyTrade({
          symbol, action: 'PARTIAL_SELL', price: currentPrice,
          amount: Math.round(currentPrice * sellQty),
          reason: partialInfo.reason,
          pnl: partialInfo.pnlPct,
        });
      }
      this.telegram.notifyTrade({
        symbol, action: 'PARTIAL_SELL', price: currentPrice,
        amount: Math.round(currentPrice * sellQty),
        reason: partialInfo.reason,
        pnl: partialInfo.pnlPct,
      });
    }
  }

  // ─── DCA (물타기) ───

  async executeDCA(symbol, position, currentPrice) {
    const balance = await this.exchange.getBalance();
    if (!balance) return;

    // DCA 금액: 최초 매수 금액 × DCA_MULTIPLIER
    const multiplier = STRATEGY.DCA_MULTIPLIER || 1.0;
    const dcaAmount = Math.floor(position.amount * multiplier / ((position.dcaCount || 0) + 1));
    if (dcaAmount < 5000) {
      logger.info(TAG, `${symbol} DCA 금액 부족 (${dcaAmount}원) → 스킵`);
      return;
    }
    if (dcaAmount > balance.free * 0.3) {
      logger.info(TAG, `${symbol} DCA 금액 잔고 대비 초과 (${dcaAmount}원 > 잔고 30%) → 스킵`);
      return;
    }

    const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const dcaCount = (position.dcaCount || 0) + 1;
    const reason = `DCA 물타기 ${dcaCount}차 (${pnlPct.toFixed(2)}%)`;

    const result = await this.exchange.buy(symbol, dcaAmount);
    if (result) {
      this.risk.executeDCA(symbol, result.price, result.quantity, dcaAmount);

      this.logger.logTrade({
        symbol, action: 'DCA', price: result.price,
        quantity: result.quantity, amount: dcaAmount,
        reason,
        pnl: null,
      });

      logger.trade(TAG, `DCA 물타기 ${dcaCount}차: ${symbol}`, {
        price: result.price, quantity: result.quantity,
        amount: dcaAmount, reason,
        newAvgPrice: Math.round(result.price),
      });

      if (this.notifier) {
        this.notifier.notifyTrade({
          symbol, action: 'DCA', price: result.price,
          amount: dcaAmount, reason,
        });
      }
      this.telegram.notifyTrade({
        symbol, action: 'DCA', price: result.price,
        amount: dcaAmount, reason,
      });
    }
  }

  // ─── 자가학습 ───

  async checkAutoLearn() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const isMidnight = now.getHours() === 0 && this.lastLearnDate !== today;
    const tradeThreshold = this.tradeCountSinceLearn >= LEARNING_TRADE_INTERVAL;

    if (isMidnight || tradeThreshold) {
      this.lastLearnDate = today;
      this.tradeCountSinceLearn = 0;
      await this.runLearning();
    }
  }

  async runLearning() {
    try {
      logger.info(TAG, '🧠 자가학습 시작...');

      // 멀티유저 데이터 취합 (다른 유저 거래 데이터도 학습에 반영)
      try {
        const mergeResult = mergeAllTrades();
        if (mergeResult.totalTrades > 0) {
          logger.info(TAG, `글로벌 데이터 취합: ${mergeResult.users}명, ${mergeResult.totalTrades}건 → merged-trades.jsonl`);
        }
      } catch (e) {
        // 취합 실패해도 개인 학습은 진행
      }

      const { DEFAULT_STRATEGY } = require('../config/strategy');
      const result = runAnalysis(DEFAULT_STRATEGY, this.logDir);

      // 리포트 출력
      printReport(result, logger);

      // 시그널 가중치 업데이트
      if (result.analysis?.byReason) {
        const newWeights = updateWeightsFromStats(result.analysis.byReason, 0.1, this.logDir);
        logger.info(TAG, `시그널 가중치 업데이트 완료`);
      }

      // 밴딧 상태 로그
      const banditSummary = this.bandit.getSummary();
      const activeContexts = Object.keys(banditSummary).length;
      if (activeContexts > 0) {
        logger.info(TAG, `밴딧 상태: ${activeContexts}개 컨텍스트 학습됨`);
      }

      // 학습 데이터 갱신
      this.learnedData = result;

      // 콤보 기반 동적 매수 기준 갱신
      this.comboMinBuyScore = getOptimalMinBuyScore(this.logDir);
      if (this.comboMinBuyScore.confidence > 0) {
        logger.info(TAG, `동적 매수 기준 갱신: ${this.comboMinBuyScore.minBuyScore} (${this.comboMinBuyScore.reason})`);
      }

      logger.info(TAG, `🧠 자가학습 완료 — ${result.tradesAnalyzed}쌍 분석, 신뢰도 ${(result.confidence * 100).toFixed(0)}%`);

      if (result.blacklist?.length > 0) {
        logger.info(TAG, `블랙리스트 갱신: ${result.blacklist.join(', ')}`);
      }

      // 콤보 통계 로그
      const comboStats = getAllComboStats(this.logDir);
      if (comboStats.length > 0) {
        const top3 = comboStats.slice(0, 3).map(c => `${c.combo}(${c.winRate}%,${c.trades}건)`).join(', ');
        logger.info(TAG, `콤보 성과 Top3: ${top3}`);
      }

      // 백테스트 자동 연동: 학습 후 백테스트도 실행
      if (result.tradesAnalyzed >= 10) {
        try {
          logger.info(TAG, '학습 후 백테스트 자동 실행...');
          const btResult = await this.runBacktestNow(this.symbols.slice(0, 3));
          if (btResult?.summary) {
            logger.info(TAG, `백테스트 결과: 승률 ${btResult.summary.winRate}% | 수익 ${btResult.summary.returnPct}% | 최적 파라미터 제안됨`);
          }
        } catch (e) {
          logger.warn(TAG, `학습 후 백테스트 실패: ${e.message}`);
        }
      }

      // 자동 파라미터 튜닝 (7일마다)
      if (shouldAutoTune(this.logDir)) {
        try {
          logger.info(TAG, '[AUTO-TUNE] 자동 파라미터 튜닝 시작...');
          const tuneResult = autoTune(this.logDir);

          if (tuneResult.success && tuneResult.changes?.length > 0) {
            for (const change of tuneResult.changes) {
              logger.info(TAG, `[AUTO-TUNE] ${change.param}: ${change.from}→${change.to} (승률 기반, ${change.sampleSize}거래, 신뢰도 ${Math.round(change.confidence * 100)}%)`);
            }
            logger.info(TAG, `[AUTO-TUNE] ${tuneResult.changes.length}개 파라미터 조정 저장 완료 (다음 재시작 시 적용)`);
          } else {
            logger.info(TAG, `[AUTO-TUNE] ${tuneResult.message}`);
          }
        } catch (e) {
          logger.warn(TAG, `[AUTO-TUNE] 자동 튜닝 실패: ${e.message}`);
        }
      }

      return result;
    } catch (error) {
      logger.error(TAG, `자가학습 실패: ${error.message}`);
      return null;
    }
  }

  // ─── 백테스트 실행 ───

  async runBacktestNow(symbols = null) {
    try {
      const testSymbols = symbols || this.symbols.slice(0, 5); // 상위 5종목
      logger.info(TAG, `백테스트 시작: ${testSymbols.join(', ')}`);
      const result = await runBacktest(this.exchange, testSymbols, { days: 7, logDir: this.logDir });
      this.lastBacktestResult = result;
      return result;
    } catch (error) {
      logger.error(TAG, `백테스트 실패: ${error.message}`);
      return null;
    }
  }

  // ─── 그리드 트레이딩 ───

  async checkGridTrades() {
    try {
      const balance = await this.exchange.getBalance();
      if (!balance || balance.free < 10000) return;

      const maxSymbols = STRATEGY.GRID_MAX_SYMBOLS || 2;
      const gridStatus = this.grid.getGridStatus();
      const activeGridSymbols = Object.keys(gridStatus.activeGrids);

      // 거래량 상위 + 안정적인 가격 변동 종목 선정
      const candidates = [];
      for (const symbol of this.symbols) {
        // 이미 일반 포지션이 있는 종목은 제외
        const positions = this.risk.getPositions();
        if (positions[symbol]) continue;

        const cachedCandles = this.candlesCache[symbol];
        if (!cachedCandles || cachedCandles.length < 20) continue;

        // 거래량 체크
        const volumes = cachedCandles.map(c => c.volume);
        const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
        const recentVol = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
        const volRatio = avgVol > 0 ? recentVol / avgVol : 0;

        if (volRatio < (STRATEGY.GRID_MIN_VOLUME || 1.0)) continue;

        // 가격 안정성 체크: 최근 20봉 변동률이 낮은 종목 우선
        const closes = cachedCandles.slice(-20).map(c => c.close);
        const priceMin = Math.min(...closes);
        const priceMax = Math.max(...closes);
        const priceRange = priceMax > 0 ? ((priceMax - priceMin) / priceMin) * 100 : 999;

        // 범위가 너무 넓으면 (5% 이상) 그리드에 부적합
        if (priceRange > 5) continue;

        candidates.push({
          symbol,
          volRatio,
          priceRange,
          currentPrice: closes[closes.length - 1],
          // 안정성 점수: 범위 좁을수록 + 거래량 높을수록 좋음
          score: volRatio / (priceRange + 0.1),
        });
      }

      // 점수순 정렬
      candidates.sort((a, b) => b.score - a.score);

      // 기존 활성 그리드 + 새 후보 합쳐서 최대 maxSymbols개
      const targetSymbols = [...activeGridSymbols];
      for (const cand of candidates) {
        if (targetSymbols.length >= maxSymbols) break;
        if (!targetSymbols.includes(cand.symbol)) {
          targetSymbols.push(cand.symbol);
        }
      }

      // 각 심볼에 대해 그리드 체크/실행
      for (const symbol of targetSymbols) {
        try {
          const ticker = await this.exchange.getTicker(symbol);
          if (!ticker) continue;

          const currentPrice = ticker.price;

          // 그리드 없으면 설정
          if (!this.grid.hasGrid(symbol)) {
            const gridOpts = {
              levels: STRATEGY.GRID_LEVELS || 3,
              spacingPct: STRATEGY.GRID_SPACING_PCT || 0.8,
              amountPct: STRATEGY.GRID_AMOUNT_PCT || 5,
            };
            this.grid.setupGrid(symbol, currentPrice, balance.free, gridOpts);

            const grid = this.grid.grids[symbol];
            const buyPrices = grid.levels.filter(l => l.type === 'BUY').map(l => l.price.toLocaleString());
            const sellPrices = grid.levels.filter(l => l.type === 'SELL').map(l => l.price.toLocaleString());
            logger.info(TAG, `그리드 설정: ${symbol} | 중심 ${currentPrice.toLocaleString()} | 매수 [${buyPrices.join(', ')}] | 매도 [${sellPrices.join(', ')}] | 레벨당 ${grid.amountPerLevel.toLocaleString()}원`);
          }

          // 그리드 시그널 체크
          const gridSignal = this.grid.checkGrid(symbol, currentPrice);

          if (gridSignal.action === 'BUY') {
            await this.executeGridBuy(symbol, gridSignal, balance.free);
          } else if (gridSignal.action === 'SELL') {
            await this.executeGridSell(symbol, gridSignal);
          }
        } catch (error) {
          logger.error(TAG, `그리드 체크 실패 (${symbol}): ${error.message}`);
        }
      }

      // 비활성 그리드 정리 (후보에서 탈락한 것)
      for (const sym of activeGridSymbols) {
        if (!targetSymbols.includes(sym)) {
          const resetResult = this.grid.resetGrid(sym);
          logger.info(TAG, `그리드 비활성 (${sym}): 후보 탈락`);
        }
      }
    } catch (error) {
      logger.error(TAG, `그리드 트레이딩 에러: ${error.message}`);
    }
  }

  async executeGridBuy(symbol, gridSignal, availableBalance) {
    const amount = gridSignal.amount;
    if (!amount || amount < 5000) {
      logger.info(TAG, `그리드 매수 금액 부족 (${symbol}, 레벨 ${gridSignal.level}): ${amount}원`);
      return;
    }
    if (amount > availableBalance * 0.3) {
      logger.info(TAG, `그리드 매수 금액 잔고 대비 초과 (${symbol}): ${amount}원 > 잔고 30%`);
      return;
    }

    const result = await this.exchange.buy(symbol, amount);
    if (result) {
      this.grid.recordFill(symbol, gridSignal.level, 'BUY', result.price, result.quantity);

      this.logger.logTrade({
        symbol, action: 'GRID_BUY', price: result.price,
        quantity: result.quantity, amount,
        reason: `그리드 매수 (레벨 ${gridSignal.level}, 목표가 ${gridSignal.price.toLocaleString()})`,
        pnl: null,
      });

      logger.trade(TAG, `그리드 매수: ${symbol} 레벨 ${gridSignal.level}`, {
        price: result.price, quantity: result.quantity,
        amount, gridLevel: gridSignal.level,
        targetPrice: gridSignal.price,
      });

      if (this.notifier) {
        this.notifier.notifyTrade({
          symbol, action: 'GRID_BUY', price: result.price,
          amount, reason: `그리드 매수 L${gridSignal.level}`,
        });
      }
      this.telegram.notifyTrade({
        symbol, action: 'GRID_BUY', price: result.price,
        amount, reason: `그리드 매수 L${gridSignal.level}`,
      });
    }
  }

  async executeGridSell(symbol, gridSignal) {
    const quantity = gridSignal.quantity;
    if (!quantity || quantity <= 0) return;

    // 실제 잔고 확인
    let sellQty = quantity;
    try {
      const holdings = await this.exchange.getHoldings();
      if (holdings) {
        const actual = holdings[symbol] || 0;
        if (actual < sellQty * 0.1) {
          logger.warn(TAG, `그리드 매도 잔고 부족 (${symbol}): 실제 ${actual}, 기록 ${sellQty}`);
          return;
        }
        if (actual < sellQty) sellQty = actual;
      }
    } catch { /* ignore */ }

    const result = await this.exchange.sell(symbol, sellQty);
    if (result) {
      const buyPairPrice = gridSignal.buyPairLevel?.fillPrice || 0;
      const pnlPct = buyPairPrice > 0 ? ((result.price - buyPairPrice) / buyPairPrice) * 100 : 0;

      this.grid.recordFill(symbol, gridSignal.level, 'SELL', result.price, sellQty);

      this.logger.logTrade({
        symbol, action: 'GRID_SELL', price: result.price,
        quantity: sellQty, amount: Math.round(result.price * sellQty),
        reason: `그리드 매도 (레벨 ${gridSignal.level}, 매수가 ${buyPairPrice.toLocaleString()})`,
        pnl: pnlPct,
      });

      logger.trade(TAG, `그리드 매도: ${symbol} 레벨 ${gridSignal.level} (수익 ${pnlPct.toFixed(2)}%)`, {
        price: result.price, quantity: sellQty,
        gridLevel: gridSignal.level,
        buyPrice: buyPairPrice,
        pnlPct: pnlPct.toFixed(2),
      });

      const gridStat = this.grid.getGridStatus();
      const gridInfo = gridStat.activeGrids[symbol];
      logger.info(TAG, `그리드 상태 (${symbol}): 라운드트립 ${gridInfo?.roundTrips || 0}회, 누적수익 ${(gridInfo?.profit || 0).toLocaleString()}원`);

      if (this.notifier) {
        this.notifier.notifyTrade({
          symbol, action: 'GRID_SELL', price: result.price,
          amount: Math.round(result.price * sellQty),
          reason: `그리드 매도 L${gridSignal.level}`,
          pnl: pnlPct,
        });
      }
      this.telegram.notifyTrade({
        symbol, action: 'GRID_SELL', price: result.price,
        amount: Math.round(result.price * sellQty),
        reason: `그리드 매도 L${gridSignal.level}`,
        pnl: pnlPct,
      });
    }
  }

  logSignal(symbol, signal) {
    if (signal.action !== 'HOLD') {
      logger.info(TAG, `시그널 [${symbol}] ${signal.action} (${this.currentRegime.regime})`, {
        reasons: signal.reasons,
        indicators: signal.indicators,
      });
    }
  }

  printStatus() {
    const positions = this.risk.getPositions();
    const posCount = Object.keys(positions).length;
    const dailyPnl = this.risk.getDailyPnl();
    const ddState = this.risk.getDrawdownState();
    const maxPos = this.risk.drawdownTracker.getMaxPositions();

    logger.info(TAG, `--- 상태 (스캔 #${this.scanCount}) [${this.currentRegime.regime}] ---`);
    logger.info(TAG, `포지션: ${posCount}/${maxPos} | 일일 손익: ${dailyPnl >= 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}원 | 연속손실: ${ddState.consecutiveLosses} | Sharpe: ${ddState.sharpeRatio} | 사이징: ${Math.round(ddState.sizingMultiplier * 100)}%`);

    for (const [sym, pos] of Object.entries(positions)) {
      const holdMin = Math.round((Date.now() - pos.entryTime) / 60000);
      const dcaInfo = pos.dcaCount ? ` | DCA${pos.dcaCount}` : '';
      const partialInfo = pos.partialSells ? ` | 분할${pos.partialSells}` : '';
      logger.info(TAG, `  ${sym}: 진입 ${pos.entryPrice.toLocaleString()} | SL ${Math.round(pos.stopLoss).toLocaleString()} | TP ${Math.round(pos.takeProfit).toLocaleString()} | 최고 ${Math.round(pos.highestPrice || pos.entryPrice).toLocaleString()} | ${holdMin}분 보유${dcaInfo}${partialInfo}`);
    }
  }

  async stop() {
    logger.info(TAG, '봇 정지 중...');
    this.running = false;
    this.telegram.stop();

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
