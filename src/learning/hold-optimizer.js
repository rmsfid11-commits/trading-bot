/**
 * 종목별 최적 보유시간 학습 (Hold Time Optimizer)
 *
 * 과거 거래에서 종목별 최적 보유시간을 학습:
 * - 수익 거래의 평균 보유시간 → 최적 보유시간
 * - 손실 거래의 보유시간 패턴 → 위험 보유시간
 * - 시간대별 수익률 분석
 *
 * 결과를 포지션 관리에 반영하여 종목별 maxHoldTime 동적 조절
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');

/**
 * 종목별 최적 보유시간 분석
 * @param {string} logDir
 * @returns {{ bySymbol, globalOptimal, analyzedAt }}
 */
function analyzeHoldTimes(logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;
  const tradesFile = path.join(dir, 'trades.jsonl');

  if (!fs.existsSync(tradesFile)) {
    return { bySymbol: {}, globalOptimal: null };
  }

  const lines = fs.readFileSync(tradesFile, 'utf-8').trim().split('\n').filter(Boolean);
  const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // BUY-SELL 매칭
  const pairs = [];
  const buyMap = {};

  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!buyMap[t.symbol]) buyMap[t.symbol] = [];
      buyMap[t.symbol].push(t);
    } else if (t.action === 'SELL' && t.pnl != null) {
      const buys = buyMap[t.symbol];
      if (buys && buys.length > 0) {
        const buy = buys.shift();
        const holdMin = Math.round((t.timestamp - buy.timestamp) / 60000);
        pairs.push({
          symbol: t.symbol,
          pnl: t.pnl,
          holdMin,
          isWin: t.pnl > 0,
        });
      }
    }
  }

  if (pairs.length < 5) {
    return { bySymbol: {}, globalOptimal: null, stats: { totalPairs: pairs.length } };
  }

  // 종목별 분석
  const bySymbol = {};
  const symbols = [...new Set(pairs.map(p => p.symbol))];

  for (const sym of symbols) {
    const symPairs = pairs.filter(p => p.symbol === sym);
    if (symPairs.length < 3) continue;

    const wins = symPairs.filter(p => p.isWin);
    const losses = symPairs.filter(p => !p.isWin);

    const avgWinHold = wins.length > 0
      ? Math.round(wins.reduce((s, p) => s + p.holdMin, 0) / wins.length)
      : null;
    const avgLossHold = losses.length > 0
      ? Math.round(losses.reduce((s, p) => s + p.holdMin, 0) / losses.length)
      : null;

    // 최적 보유시간: 수익 거래 평균의 1.2배 (약간 여유)
    const optimalHoldMin = avgWinHold ? Math.round(avgWinHold * 1.2) : null;

    // 보유시간 구간별 승률
    const buckets = analyzeHoldBuckets(symPairs);

    bySymbol[sym] = {
      trades: symPairs.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(wins.length / symPairs.length * 100),
      avgWinHold,
      avgLossHold,
      optimalHoldMin,
      avgPnl: Math.round(symPairs.reduce((s, p) => s + p.pnl, 0) / symPairs.length * 100) / 100,
      buckets,
    };
  }

  // 전체 최적 보유시간
  const allWins = pairs.filter(p => p.isWin);
  const globalAvgWinHold = allWins.length > 0
    ? Math.round(allWins.reduce((s, p) => s + p.holdMin, 0) / allWins.length)
    : null;
  const globalBuckets = analyzeHoldBuckets(pairs);

  const globalOptimal = {
    trades: pairs.length,
    avgWinHold: globalAvgWinHold,
    optimalHoldMin: globalAvgWinHold ? Math.round(globalAvgWinHold * 1.2) : null,
    buckets: globalBuckets,
  };

  // 결과 저장
  const resultFile = path.join(dir, 'hold-optimizer.json');
  try {
    fs.writeFileSync(resultFile, JSON.stringify({
      bySymbol,
      globalOptimal,
      analyzedAt: Date.now(),
    }, null, 2));
  } catch { /* ignore */ }

  return { bySymbol, globalOptimal };
}

/**
 * 특정 종목의 최적 보유시간 가져오기
 * @param {string} symbol
 * @param {string} logDir
 * @returns {{ optimalHoldMin, maxHoldHours, confidence }} or null
 */
function getOptimalHoldTime(symbol, logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;
  const resultFile = path.join(dir, 'hold-optimizer.json');

  if (!fs.existsSync(resultFile)) return null;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
  } catch {
    return null;
  }

  // 종목별 데이터 우선
  const symData = data.bySymbol?.[symbol];
  if (symData && symData.optimalHoldMin && symData.trades >= 5) {
    return {
      optimalHoldMin: symData.optimalHoldMin,
      maxHoldHours: Math.round(symData.optimalHoldMin / 60 * 10) / 10,
      confidence: Math.min(1.0, symData.trades / 20),
      source: 'symbol',
    };
  }

  // 종목별 데이터 부족 시 글로벌 평균 사용
  const global = data.globalOptimal;
  if (global?.optimalHoldMin) {
    return {
      optimalHoldMin: global.optimalHoldMin,
      maxHoldHours: Math.round(global.optimalHoldMin / 60 * 10) / 10,
      confidence: Math.min(0.5, global.trades / 40),
      source: 'global',
    };
  }

  return null;
}

// ─── 내부 함수 ───

function analyzeHoldBuckets(pairs) {
  const buckets = [
    { label: '0-15분', min: 0, max: 15 },
    { label: '15-30분', min: 15, max: 30 },
    { label: '30-60분', min: 30, max: 60 },
    { label: '1-2시간', min: 60, max: 120 },
    { label: '2-4시간', min: 120, max: 240 },
    { label: '4시간+', min: 240, max: Infinity },
  ];

  return buckets.map(b => {
    const matched = pairs.filter(p => p.holdMin >= b.min && p.holdMin < b.max);
    if (matched.length === 0) return { label: b.label, trades: 0, winRate: 0, avgPnl: 0 };

    const wins = matched.filter(p => p.isWin).length;
    return {
      label: b.label,
      trades: matched.length,
      winRate: Math.round(wins / matched.length * 100),
      avgPnl: Math.round(matched.reduce((s, p) => s + p.pnl, 0) / matched.length * 100) / 100,
    };
  });
}

module.exports = { analyzeHoldTimes, getOptimalHoldTime };
