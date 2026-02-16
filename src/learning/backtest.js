/**
 * 히스토리컬 캔들 백테스터
 *
 * 과거 캔들 데이터로 시그널 생성 → 가상 매매 시뮬레이션
 * 다양한 파라미터 조합을 테스트해서 최적 설정 탐색
 *
 * 사용법:
 *   node -e "require('./src/learning/backtest').runBacktest()"
 *   또는 대시보드에서 "백테스트 실행" 버튼
 */

const { calculateRSI } = require('../indicators/rsi');
const { calculateBollinger } = require('../indicators/bollinger');
const { analyzeVolume } = require('../indicators/volume');
const { calculateMACD } = require('../indicators/macd');
const { calculateATR, getDynamicSLTP } = require('../indicators/atr');
const { detectCandlePatterns, getPatternScore } = require('../indicators/patterns');
const { STRATEGY, DEFAULT_STRATEGY } = require('../config/strategy');
const { logger } = require('../logger/trade-logger');

const fs = require('fs');
const path = require('path');

const TAG = 'BACKTEST';
const DEFAULT_RESULTS_PATH = path.join(__dirname, '../../logs/backtest-results.json');

// ─── 백테스트 엔진 ───

/**
 * 캔들 데이터로 백테스트 실행
 * @param {Array} candles - OHLCV 데이터 [{ timestamp, open, high, low, close, volume }]
 * @param {Object} params - 전략 파라미터 오버라이드
 * @param {Object} opts - { initialBalance, positionPct, maxPositions, verbose }
 * @returns {{ trades, stats, equity }}
 */
function simulateTrades(candles, params = {}, opts = {}) {
  const config = { ...DEFAULT_STRATEGY, ...params };
  const {
    initialBalance = 1000000,
    positionPct = 0.18,
    verbose = false,
  } = opts;

  // 최소 캔들 수 체크
  const minCandles = Math.max(config.BOLLINGER_PERIOD + 1, config.RSI_PERIOD + 2, 30);
  if (candles.length < minCandles) {
    return { trades: [], stats: getEmptyStats(), equity: [] };
  }

  let balance = initialBalance;
  let position = null; // { entryPrice, quantity, amount, entryIdx, stopLoss, takeProfit, highestPrice }
  const trades = [];
  const equity = []; // { time, value }

  for (let i = minCandles; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const current = candles[i];
    const currentPrice = current.close;

    // 포트폴리오 가치 기록 (10캔들마다)
    if (i % 10 === 0) {
      const posValue = position ? position.quantity * currentPrice : 0;
      equity.push({ time: current.timestamp, value: Math.round(balance + posValue) });
    }

    // ─── 포지션 보유 중: 손절/익절/시간제한 체크 ───
    if (position) {
      // 트레일링 스탑: 최고가 갱신
      if (currentPrice > position.highestPrice) {
        position.highestPrice = currentPrice;
        const newStop = currentPrice * (1 + config.STOP_LOSS_PCT / 100);
        if (newStop > position.stopLoss) {
          position.stopLoss = newStop;
        }
      }

      // 고가/저가로 손절/익절 확인 (캔들 내 가격)
      const high = current.high;
      const low = current.low;

      let exitPrice = null;
      let exitReason = null;

      if (low <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'STOP_LOSS';
      } else if (high >= position.takeProfit) {
        exitPrice = position.takeProfit;
        exitReason = 'TAKE_PROFIT';
      } else {
        // 최대 보유시간 체크 (캔들 수 기반, 5분봉 기준)
        const holdCandles = i - position.entryIdx;
        const maxHoldCandles = config.MAX_HOLD_HOURS * 12; // 5분봉 기준
        if (holdCandles >= maxHoldCandles) {
          exitPrice = currentPrice;
          exitReason = 'TIME_LIMIT';
        }
      }

      if (exitPrice) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const pnl = (exitPrice - position.entryPrice) * position.quantity;
        balance += position.amount + pnl;

        trades.push({
          entryIdx: position.entryIdx,
          exitIdx: i,
          entryTime: candles[position.entryIdx].timestamp,
          exitTime: current.timestamp,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPct: Math.round(pnlPct * 100) / 100,
          pnl: Math.round(pnl),
          reason: exitReason,
          holdCandles: i - position.entryIdx,
        });

        position = null;
      }

      continue; // 포지션 보유 중엔 매수 안 함
    }

    // ─── 시그널 생성 (간소화 버전) ───
    const closes = window.map(c => c.close);
    const volumes = window.map(c => c.volume);

    const rsi = calculateRSI(closes, config.RSI_PERIOD);
    const bollinger = calculateBollinger(closes, config.BOLLINGER_PERIOD, config.BOLLINGER_STD_DEV);
    const volume = analyzeVolume(volumes);
    const macd = calculateMACD(window);

    if (!rsi || !bollinger) continue;

    let buyScore = 0;

    // RSI 과매도
    if (rsi <= config.RSI_OVERSOLD) buyScore += 1.5;

    // 볼린저 하단 터치/근접
    if (currentPrice <= bollinger.lower) {
      buyScore += 1.5;
    } else {
      const bandWidth = bollinger.upper - bollinger.lower;
      const pricePos = bandWidth > 0 ? (currentPrice - bollinger.lower) / bandWidth : 0.5;
      if (pricePos <= 0.3) buyScore += 1.0;
    }

    // 거래량 급등
    if (volume.isHigh) buyScore += 0.5;

    // MACD 골든크로스
    if (macd?.bullish) buyScore += 1.0;
    if (macd?.trend === 'UP') buyScore += 0.3;

    // 캔들스틱 패턴
    const trendCtx = rsi < 40 ? 'down' : rsi > 60 ? 'up' : 'neutral';
    const patterns = detectCandlePatterns(window);
    const patScore = getPatternScore(patterns, trendCtx);
    buyScore += patScore.buyScore;

    // ─── 매수 조건 ───
    const buyThreshold = params.BUY_THRESHOLD || 2.0;
    if (buyScore >= buyThreshold && balance > 10000) {
      const amount = Math.floor(balance * positionPct);
      if (amount >= 5000) {
        const quantity = amount / currentPrice;

        // ATR 기반 동적 SL/TP
        let slPct = config.STOP_LOSS_PCT;
        let tpPct = config.TAKE_PROFIT_PCT;

        if (params.USE_ATR_SLTP) {
          const atrResult = getDynamicSLTP(window);
          if (atrResult) {
            slPct = atrResult.stopLossPct;
            tpPct = atrResult.takeProfitPct;
          }
        }

        position = {
          entryPrice: currentPrice,
          quantity,
          amount,
          entryIdx: i,
          stopLoss: currentPrice * (1 + slPct / 100),
          takeProfit: currentPrice * (1 + tpPct / 100),
          highestPrice: currentPrice,
        };

        balance -= amount;
      }
    }
  }

  // 미청산 포지션 강제 청산
  if (position) {
    const lastPrice = candles[candles.length - 1].close;
    const pnlPct = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
    const pnl = (lastPrice - position.entryPrice) * position.quantity;
    balance += position.amount + pnl;

    trades.push({
      entryIdx: position.entryIdx,
      exitIdx: candles.length - 1,
      entryTime: candles[position.entryIdx].timestamp,
      exitTime: candles[candles.length - 1].timestamp,
      entryPrice: position.entryPrice,
      exitPrice: lastPrice,
      pnlPct: Math.round(pnlPct * 100) / 100,
      pnl: Math.round(pnl),
      reason: 'FORCE_CLOSE',
      holdCandles: candles.length - 1 - position.entryIdx,
    });
  }

  // 최종 포트폴리오 가치
  equity.push({ time: candles[candles.length - 1].timestamp, value: Math.round(balance) });

  const stats = calcStats(trades, initialBalance, balance);
  return { trades, stats, equity };
}

function getEmptyStats() {
  return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnlPct: 0, avgPnlPct: 0, maxDrawdown: 0,
    profitFactor: 0, sharpeRatio: 0,
    avgHoldCandles: 0, finalBalance: 0, returnPct: 0,
  };
}

function calcStats(trades, initialBalance, finalBalance) {
  if (trades.length === 0) return { ...getEmptyStats(), finalBalance, returnPct: 0 };

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnlPct = totalPnlPct / trades.length;

  // 최대 낙폭
  let peak = initialBalance;
  let maxDD = 0;
  let running = initialBalance;
  for (const t of trades) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Profit Factor
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : grossProfit > 0 ? 999 : 0;

  // Sharpe Ratio (간이 버전)
  const mean = avgPnlPct;
  const variance = trades.reduce((s, t) => s + (t.pnlPct - mean) ** 2, 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? Math.round(mean / stdDev * 100) / 100 : 0;

  // 연속 손실
  let maxConsecLoss = 0;
  let consecLoss = 0;
  for (const t of trades) {
    if (t.pnlPct <= 0) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }

  // 평균 보유 캔들 수
  const avgHold = trades.reduce((s, t) => s + t.holdCandles, 0) / trades.length;

  // 승/패 평균
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  // 이유별 통계
  const byReason = {};
  for (const t of trades) {
    if (!byReason[t.reason]) byReason[t.reason] = { count: 0, wins: 0, totalPnl: 0 };
    byReason[t.reason].count++;
    if (t.pnlPct > 0) byReason[t.reason].wins++;
    byReason[t.reason].totalPnl += t.pnlPct;
  }
  for (const r of Object.values(byReason)) {
    r.winRate = Math.round((r.wins / r.count) * 100);
    r.avgPnl = Math.round((r.totalPnl / r.count) * 100) / 100;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round((wins.length / trades.length) * 100),
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    avgPnlPct: Math.round(avgPnlPct * 100) / 100,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxConsecutiveLosses: maxConsecLoss,
    profitFactor,
    sharpeRatio: sharpe,
    avgHoldCandles: Math.round(avgHold),
    finalBalance: Math.round(finalBalance),
    returnPct: Math.round(((finalBalance - initialBalance) / initialBalance) * 10000) / 100,
    byReason,
  };
}

// ─── 파라미터 그리드 서치 ───

/**
 * 여러 파라미터 조합으로 백테스트 실행
 * @param {Array} candles
 * @param {Object} paramGrid - { RSI_OVERSOLD: [30, 35, 40], ... }
 * @param {Object} opts
 * @returns {Array} 결과 배열 (수익률 순 정렬)
 */
function gridSearch(candles, paramGrid = {}, opts = {}) {
  const defaults = {
    RSI_OVERSOLD: [30, 35, 40],
    RSI_OVERBOUGHT: [65, 70, 75],
    STOP_LOSS_PCT: [-1.0, -1.5, -2.0, -2.5],
    TAKE_PROFIT_PCT: [1.5, 2.0, 2.5, 3.0],
    MAX_HOLD_HOURS: [2, 4, 6],
    BUY_THRESHOLD: [1.5, 2.0, 2.5, 3.0],
    ...paramGrid,
  };

  // 조합 생성 (그리드가 너무 크면 제한)
  const combinations = generateCombinations(defaults);
  const maxCombos = opts.maxCombinations || 500;
  const combos = combinations.length > maxCombos
    ? sampleCombinations(combinations, maxCombos)
    : combinations;

  const results = [];

  for (const combo of combos) {
    const { trades, stats } = simulateTrades(candles, combo, { ...opts, verbose: false });
    if (stats.totalTrades >= 3) { // 최소 3거래
      results.push({
        params: combo,
        stats,
        score: calcComboScore(stats),
      });
    }
  }

  // 종합 점수 순 정렬
  results.sort((a, b) => b.score - a.score);

  return results;
}

function generateCombinations(paramGrid) {
  const keys = Object.keys(paramGrid);
  const combos = [{}];

  for (const key of keys) {
    const values = paramGrid[key];
    const newCombos = [];
    for (const combo of combos) {
      for (const val of values) {
        newCombos.push({ ...combo, [key]: val });
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }

  return combos;
}

function sampleCombinations(combos, maxCount) {
  // 랜덤 샘플링
  const shuffled = combos.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, maxCount);
}

function calcComboScore(stats) {
  // 종합 점수: 수익률 30% + 승률 25% + 샤프 20% + PF 15% + 낮은 DD 10%
  const returnScore = Math.min(100, Math.max(0, stats.returnPct + 10) * 2);
  const winScore = stats.winRate;
  const sharpeScore = Math.min(100, Math.max(0, stats.sharpeRatio * 50 + 50));
  const pfScore = Math.min(100, stats.profitFactor * 30);
  const ddScore = Math.max(0, 100 - stats.maxDrawdown * 5);

  return Math.round(
    returnScore * 0.30 +
    winScore * 0.25 +
    sharpeScore * 0.20 +
    pfScore * 0.15 +
    ddScore * 0.10
  );
}

// ─── ATR SL/TP 비교 테스트 ───

/**
 * 고정 SL/TP vs ATR 동적 SL/TP 비교
 */
function compareATRvsFixed(candles) {
  // 고정 SL/TP
  const fixedResult = simulateTrades(candles, {
    STOP_LOSS_PCT: STRATEGY.STOP_LOSS_PCT,
    TAKE_PROFIT_PCT: STRATEGY.TAKE_PROFIT_PCT,
    USE_ATR_SLTP: false,
  });

  // ATR 동적 SL/TP
  const atrResult = simulateTrades(candles, {
    USE_ATR_SLTP: true,
  });

  return {
    fixed: {
      label: `고정 SL${STRATEGY.STOP_LOSS_PCT}%/TP+${STRATEGY.TAKE_PROFIT_PCT}%`,
      stats: fixedResult.stats,
    },
    atr: {
      label: 'ATR 동적 SL/TP',
      stats: atrResult.stats,
    },
    winner: atrResult.stats.returnPct > fixedResult.stats.returnPct ? 'ATR' : 'FIXED',
    improvement: Math.round((atrResult.stats.returnPct - fixedResult.stats.returnPct) * 100) / 100,
  };
}

// ─── 통합 백테스트 실행 ───

/**
 * 전체 백테스트: 과거 캔들 로드 → 시뮬레이션 → 최적 파라미터 탐색 → 결과 저장
 * @param {Object} exchange - UpbitExchange 인스턴스
 * @param {string[]} symbols - 테스트할 종목 목록
 * @param {Object} opts - { days, gridSearch, verbose }
 */
async function runBacktest(exchange, symbols = ['BTC/KRW'], opts = {}) {
  const {
    days = 7,
    doGridSearch = true,
    verbose = true,
  } = opts;

  if (verbose) logger.info(TAG, `백테스트 시작: ${symbols.join(', ')} (${days}일)`);

  const results = {};
  const candleCount = days * 288; // 5분봉: 하루 288개

  for (const symbol of symbols) {
    try {
      if (verbose) logger.info(TAG, `${symbol} 캔들 ${candleCount}개 로딩...`);
      const candles = await exchange.getCandles(symbol, '5m', Math.min(candleCount, 200));
      if (!candles || candles.length < 50) {
        if (verbose) logger.warn(TAG, `${symbol} 캔들 부족 (${candles?.length || 0}개)`);
        continue;
      }

      // 1. 현재 전략으로 백테스트
      const currentResult = simulateTrades(candles, STRATEGY);

      // 2. ATR 비교 테스트
      const atrComparison = compareATRvsFixed(candles);

      // 3. 그리드 서치 (선택)
      let gridResults = null;
      let bestParams = null;

      if (doGridSearch) {
        if (verbose) logger.info(TAG, `${symbol} 그리드 서치 중...`);
        const grid = gridSearch(candles, {}, { maxCombinations: 300 });
        gridResults = grid.slice(0, 10); // 상위 10개만
        bestParams = grid.length > 0 ? grid[0] : null;
      }

      results[symbol] = {
        symbol,
        candleCount: candles.length,
        period: {
          from: new Date(candles[0].timestamp).toISOString(),
          to: new Date(candles[candles.length - 1].timestamp).toISOString(),
        },
        currentStrategy: {
          params: {
            RSI_OVERSOLD: STRATEGY.RSI_OVERSOLD,
            RSI_OVERBOUGHT: STRATEGY.RSI_OVERBOUGHT,
            STOP_LOSS_PCT: STRATEGY.STOP_LOSS_PCT,
            TAKE_PROFIT_PCT: STRATEGY.TAKE_PROFIT_PCT,
            MAX_HOLD_HOURS: STRATEGY.MAX_HOLD_HOURS,
          },
          stats: currentResult.stats,
          equity: currentResult.equity,
        },
        atrComparison,
        gridSearch: gridResults ? {
          totalTested: gridResults.length,
          best: bestParams,
          top10: gridResults,
        } : null,
      };

      if (verbose) {
        const cs = currentResult.stats;
        logger.info(TAG, `${symbol} 현재전략: ${cs.totalTrades}거래, 승률 ${cs.winRate}%, 수익 ${cs.returnPct}%, MDD ${cs.maxDrawdown}%`);
        logger.info(TAG, `${symbol} ATR vs 고정: ${atrComparison.winner} 승 (차이 ${atrComparison.improvement}%p)`);
        if (bestParams) {
          const bs = bestParams.stats;
          logger.info(TAG, `${symbol} 최적 파라미터: 승률 ${bs.winRate}%, 수익 ${bs.returnPct}%, SL${bestParams.params.STOP_LOSS_PCT}%/TP+${bestParams.params.TAKE_PROFIT_PCT}%`);
        }
      }
    } catch (error) {
      if (verbose) logger.error(TAG, `${symbol} 백테스트 실패: ${error.message}`);
      results[symbol] = { symbol, error: error.message };
    }
  }

  // 결과 저장
  const output = {
    runAt: Date.now(),
    days,
    symbols,
    results,
    summary: generateSummary(results),
  };

  const resultsPath = opts.logDir ? path.join(opts.logDir, 'backtest-results.json') : DEFAULT_RESULTS_PATH;
  const dir = path.dirname(resultsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2), 'utf-8');

  if (verbose) {
    logger.info(TAG, '=== 백테스트 요약 ===');
    const s = output.summary;
    logger.info(TAG, `테스트 종목: ${s.testedSymbols}개 | 현재 전략 승률: ${s.currentAvgWinRate}% | 최적 승률: ${s.bestAvgWinRate}%`);
    logger.info(TAG, `추천 파라미터: SL ${s.recommendedParams?.STOP_LOSS_PCT}% | TP ${s.recommendedParams?.TAKE_PROFIT_PCT}% | RSI ${s.recommendedParams?.RSI_OVERSOLD}/${s.recommendedParams?.RSI_OVERBOUGHT}`);
    if (s.atrBetter) logger.info(TAG, `ATR 동적 SL/TP가 더 좋은 종목: ${s.atrBetterSymbols.join(', ')}`);
  }

  return output;
}

function generateSummary(results) {
  const symbols = Object.values(results).filter(r => !r.error);

  if (symbols.length === 0) {
    return { testedSymbols: 0, currentAvgWinRate: 0, bestAvgWinRate: 0, recommendedParams: null };
  }

  // 현재 전략 평균 승률
  const currentWinRates = symbols.map(r => r.currentStrategy?.stats?.winRate || 0);
  const currentAvgWinRate = Math.round(currentWinRates.reduce((s, v) => s + v, 0) / currentWinRates.length);

  // 최적 파라미터 평균 승률
  const bestWinRates = symbols
    .filter(r => r.gridSearch?.best?.stats)
    .map(r => r.gridSearch.best.stats.winRate);
  const bestAvgWinRate = bestWinRates.length > 0
    ? Math.round(bestWinRates.reduce((s, v) => s + v, 0) / bestWinRates.length)
    : currentAvgWinRate;

  // 추천 파라미터: 가장 많이 등장한 최적값
  const paramVotes = {};
  for (const r of symbols) {
    if (!r.gridSearch?.best?.params) continue;
    const p = r.gridSearch.best.params;
    for (const [key, val] of Object.entries(p)) {
      if (!paramVotes[key]) paramVotes[key] = {};
      paramVotes[key][val] = (paramVotes[key][val] || 0) + 1;
    }
  }

  const recommendedParams = {};
  for (const [key, votes] of Object.entries(paramVotes)) {
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    recommendedParams[key] = Number(sorted[0][0]);
  }

  // ATR 비교
  const atrBetterSymbols = symbols
    .filter(r => r.atrComparison?.winner === 'ATR')
    .map(r => r.symbol);

  return {
    testedSymbols: symbols.length,
    currentAvgWinRate,
    bestAvgWinRate,
    improvement: bestAvgWinRate - currentAvgWinRate,
    recommendedParams,
    atrBetter: atrBetterSymbols.length > symbols.length / 2,
    atrBetterSymbols,
  };
}

// ─── 백테스트 결과 로드 ───

function loadBacktestResults(logDir = null) {
  try {
    const resultsPath = logDir ? path.join(logDir, 'backtest-results.json') : DEFAULT_RESULTS_PATH;
    if (!fs.existsSync(resultsPath)) return null;
    return JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  } catch { return null; }
}

module.exports = {
  simulateTrades,
  gridSearch,
  compareATRvsFixed,
  runBacktest,
  loadBacktestResults,
};
