const { generateSignal } = require('../strategy/signals');
const { RiskManager } = require('../risk/manager');
const { logger } = require('../logger/trade-logger');
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
const { calculateKimchiPremium } = require('../indicators/kimchi-premium');
const { calculateATR } = require('../indicators/atr');
const { TelegramBot } = require('../notification/telegram');
const { mergeAllTrades } = require('../learning/merger');

const TAG = 'BOT';
const SYMBOL_REFRESH_INTERVAL = 3600000; // 1시간마다 종목 갱신
const LEARNING_TRADE_INTERVAL = 50; // 50거래마다 학습

class TradingBot {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.userId = options.userId || null;
    this.logDir = options.logDir || null;
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

    // 확인 캔들 필터: 대기 중인 시그널
    this.pendingSignals = {}; // symbol → { signal, mtf, candle, time }

    // 텔레그램 봇
    this.telegram = new TelegramBot(this);
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
        logger.logTrade({
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
    } catch (error) {
      logger.error(TAG, `김프 업데이트 실패: ${error.message}`);
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

          // DCA (물타기) 체크
          const dcaCheck = this.risk.checkDCACondition(symbol, ticker.price);
          if (dcaCheck) {
            // 시그널이 여전히 강한지 확인
            const candles = await this.exchange.getCandles(symbol);
            if (candles) {
              const signal = generateSignal(candles, { regime });
              if (signal.scores?.buy >= 2.5) {
                await this.executeDCA(symbol, positions[symbol], ticker.price, signal, dcaCheck);
              }
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

        // 김프 부스트
        const kimchiBuy = this.kimchiPremium?.buyBoost || 0;
        const kimchiSell = this.kimchiPremium?.sellBoost || 0;

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
          sentimentBuyBoost: sentBoost.buyBoost,
          sentimentSellBoost: sentBoost.sellBoost,
          orderbookScore: obScore,
          kimchiBuyBoost: kimchiBuy,
          kimchiSellBoost: kimchiSell,
        });
        this.lastSignals[symbol] = { ...signal, mtf, sentiment: sentBoost, orderbook: obScore, kimchi: this.kimchiPremium };
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

    // 바운드: 8% ~ 18%
    basePct = Math.max(0.08, Math.min(0.18, basePct));

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

    const result = await this.exchange.buy(symbol, amount);
    if (result) {
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
      logger.logTrade({
        symbol, action: 'BUY', price: result.price,
        quantity: result.quantity, amount,
        reason: signal.reasons.join(', '),
        pnl: null,
        snapshot: signal.snapshot || null,
        regime,
        banditProfile: banditChoice.profile,
        mtfSignal: mtf?.signal || 'neutral',
      });

      logger.trade(TAG, `매수 체결: ${symbol} [${regime}/${banditChoice.profile}] MTF:${mtf?.signal || '-'}`, {
        price: result.price, quantity: result.quantity,
        amount, reason: signal.reasons.join(', '),
        buyScore: signal.scores?.buy,
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

      logger.logTrade({
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

      logger.logTrade({
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
    }
  }

  // ─── DCA (물타기) ───

  async executeDCA(symbol, position, currentPrice, signal, dcaInfo) {
    const balance = await this.exchange.getBalance();
    if (!balance) return;

    // DCA 금액: 원래 투자금의 50%
    const dcaAmount = Math.floor(position.amount * 0.5);
    if (dcaAmount < 5000 || dcaAmount > balance.free * 0.15) {
      logger.info(TAG, `${symbol} DCA 금액 부족 또는 비율 초과 → 스킵`);
      return;
    }

    const result = await this.exchange.buy(symbol, dcaAmount);
    if (result) {
      this.risk.addToPosition(symbol, result.price, result.quantity, dcaAmount);

      logger.logTrade({
        symbol, action: 'DCA', price: result.price,
        quantity: result.quantity, amount: dcaAmount,
        reason: dcaInfo.reason,
        pnl: null,
        snapshot: signal.snapshot || null,
      });

      logger.trade(TAG, `DCA 물타기 ${dcaInfo.dcaCount}차: ${symbol}`, {
        price: result.price, quantity: result.quantity,
        amount: dcaAmount, reason: dcaInfo.reason,
      });

      if (this.notifier) {
        this.notifier.notifyTrade({
          symbol, action: 'DCA', price: result.price,
          amount: dcaAmount, reason: dcaInfo.reason,
        });
      }
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
