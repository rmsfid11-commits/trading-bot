/**
 * 손절 패턴 분석기 (Loss Pattern Analyzer)
 *
 * 과거 손실 거래를 분석하여 반복되는 패턴 감지:
 * - RSI 범위별 손실률
 * - BB 포지션별 손실률
 * - 시간대별 손실률
 * - 레짐별 손실률
 * - 특정 종목 패턴
 *
 * 60%+ 손실률 패턴 → 자동 차단 (block) (70→60: 더 빨리 차단)
 * 50%+ 손실률 패턴 → 경고 (warn)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');

/**
 * 거래 기록에서 손실 패턴 분석
 * @param {string} logDir
 * @returns {{ patterns, blockRules, stats }}
 */
function analyzeLossPatterns(logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;
  const tradesFile = path.join(dir, 'trades.jsonl');

  if (!fs.existsSync(tradesFile)) {
    return { patterns: [], blockRules: [], stats: {} };
  }

  const lines = fs.readFileSync(tradesFile, 'utf-8').trim().split('\n').filter(Boolean);
  const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // BUY-SELL 매칭
  const pairs = matchBuySell(trades);
  if (pairs.length < 10) {
    return { patterns: [], blockRules: [], stats: { totalPairs: pairs.length, message: '데이터 부족 (최소 10쌍)' } };
  }

  // 패턴 분석
  const patterns = [];

  // 1. RSI 범위별
  const rsiRanges = [
    { label: 'RSI<25', test: p => p.buySnapshot?.rsi < 25 },
    { label: 'RSI 25-30', test: p => p.buySnapshot?.rsi >= 25 && p.buySnapshot?.rsi < 30 },
    { label: 'RSI 30-35', test: p => p.buySnapshot?.rsi >= 30 && p.buySnapshot?.rsi < 35 },
    { label: 'RSI 35-45', test: p => p.buySnapshot?.rsi >= 35 && p.buySnapshot?.rsi < 45 },
    { label: 'RSI 45-55', test: p => p.buySnapshot?.rsi >= 45 && p.buySnapshot?.rsi < 55 },
    { label: 'RSI>55', test: p => p.buySnapshot?.rsi >= 55 },
  ];

  for (const range of rsiRanges) {
    const matched = pairs.filter(range.test);
    if (matched.length >= 3) {
      const losses = matched.filter(p => p.pnl <= 0).length;
      const lossRate = losses / matched.length;
      const avgPnl = matched.reduce((s, p) => s + p.pnl, 0) / matched.length;
      patterns.push({
        type: 'rsi',
        label: range.label,
        trades: matched.length,
        lossRate: Math.round(lossRate * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
      });
    }
  }

  // 2. BB 포지션별
  const bbRanges = [
    { label: 'BB<10%', test: p => p.buySnapshot?.bbPosition < 0.1 },
    { label: 'BB 10-30%', test: p => p.buySnapshot?.bbPosition >= 0.1 && p.buySnapshot?.bbPosition < 0.3 },
    { label: 'BB 30-50%', test: p => p.buySnapshot?.bbPosition >= 0.3 && p.buySnapshot?.bbPosition < 0.5 },
    { label: 'BB 50-70%', test: p => p.buySnapshot?.bbPosition >= 0.5 && p.buySnapshot?.bbPosition < 0.7 },
    { label: 'BB>70%', test: p => p.buySnapshot?.bbPosition >= 0.7 },
  ];

  for (const range of bbRanges) {
    const matched = pairs.filter(range.test);
    if (matched.length >= 3) {
      const losses = matched.filter(p => p.pnl <= 0).length;
      const lossRate = losses / matched.length;
      const avgPnl = matched.reduce((s, p) => s + p.pnl, 0) / matched.length;
      patterns.push({
        type: 'bb',
        label: range.label,
        trades: matched.length,
        lossRate: Math.round(lossRate * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
      });
    }
  }

  // 3. 시간대별 (3시간 단위)
  const hourBuckets = [
    { label: '0-3시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 0 && h < 3; } },
    { label: '3-6시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 3 && h < 6; } },
    { label: '6-9시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 6 && h < 9; } },
    { label: '9-12시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 9 && h < 12; } },
    { label: '12-15시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 12 && h < 15; } },
    { label: '15-18시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 15 && h < 18; } },
    { label: '18-21시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 18 && h < 21; } },
    { label: '21-24시', test: p => { const h = new Date(p.buyTime).getHours(); return h >= 21 && h < 24; } },
  ];

  for (const bucket of hourBuckets) {
    const matched = pairs.filter(bucket.test);
    if (matched.length >= 3) {
      const losses = matched.filter(p => p.pnl <= 0).length;
      const lossRate = losses / matched.length;
      const avgPnl = matched.reduce((s, p) => s + p.pnl, 0) / matched.length;
      patterns.push({
        type: 'hour',
        label: bucket.label,
        trades: matched.length,
        lossRate: Math.round(lossRate * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
      });
    }
  }

  // 4. 레짐별
  const regimes = ['trending', 'ranging', 'volatile'];
  for (const reg of regimes) {
    const matched = pairs.filter(p => p.regime === reg);
    if (matched.length >= 3) {
      const losses = matched.filter(p => p.pnl <= 0).length;
      const lossRate = losses / matched.length;
      const avgPnl = matched.reduce((s, p) => s + p.pnl, 0) / matched.length;
      patterns.push({
        type: 'regime',
        label: reg,
        trades: matched.length,
        lossRate: Math.round(lossRate * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
      });
    }
  }

  // 5. 종목별
  const symbols = [...new Set(pairs.map(p => p.symbol))];
  for (const sym of symbols) {
    const matched = pairs.filter(p => p.symbol === sym);
    if (matched.length >= 5) {
      const losses = matched.filter(p => p.pnl <= 0).length;
      const lossRate = losses / matched.length;
      const avgPnl = matched.reduce((s, p) => s + p.pnl, 0) / matched.length;
      patterns.push({
        type: 'symbol',
        label: sym.replace('/KRW', ''),
        trades: matched.length,
        lossRate: Math.round(lossRate * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
      });
    }
  }

  // 차단 규칙 생성
  const blockRules = [];
  for (const p of patterns) {
    if (p.lossRate >= 60 && p.trades >= 5) {
      blockRules.push({ ...p, action: 'block', reason: `손실률 ${p.lossRate}% (${p.trades}건)` });
    } else if (p.lossRate >= 50 && p.trades >= 5) {
      blockRules.push({ ...p, action: 'warn', reason: `손실률 ${p.lossRate}% (${p.trades}건)` });
    }
  }

  // 결과 저장
  const resultFile = path.join(dir, 'loss-patterns.json');
  try {
    fs.writeFileSync(resultFile, JSON.stringify({
      patterns: patterns.sort((a, b) => b.lossRate - a.lossRate),
      blockRules,
      analyzedAt: Date.now(),
      totalPairs: pairs.length,
    }, null, 2));
  } catch { /* ignore */ }

  return {
    patterns: patterns.sort((a, b) => b.lossRate - a.lossRate),
    blockRules,
    stats: {
      totalPairs: pairs.length,
      wins: pairs.filter(p => p.pnl > 0).length,
      losses: pairs.filter(p => p.pnl <= 0).length,
      avgPnl: Math.round(pairs.reduce((s, p) => s + p.pnl, 0) / pairs.length * 100) / 100,
    },
  };
}

/**
 * 새 시그널이 차단 패턴에 해당하는지 체크
 * @param {Object} snapshot - 시그널 스냅샷 (rsi, bbPosition 등)
 * @param {string} symbol
 * @param {string} regime
 * @param {string} logDir
 * @returns {{ blocked, warnings, reasons }}
 */
function checkLossPattern(snapshot, symbol, regime, logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;
  const resultFile = path.join(dir, 'loss-patterns.json');

  if (!fs.existsSync(resultFile)) {
    return { blocked: false, warnings: [], reasons: [] };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
  } catch {
    return { blocked: false, warnings: [], reasons: [] };
  }

  if (!data.blockRules || data.blockRules.length === 0) {
    return { blocked: false, warnings: [], reasons: [] };
  }

  const blocked = [];
  const warnings = [];
  const hour = new Date().getHours();

  for (const rule of data.blockRules) {
    let matches = false;

    switch (rule.type) {
      case 'rsi':
        if (rule.label === 'RSI<25' && snapshot?.rsi < 25) matches = true;
        if (rule.label === 'RSI 25-30' && snapshot?.rsi >= 25 && snapshot?.rsi < 30) matches = true;
        if (rule.label === 'RSI 30-35' && snapshot?.rsi >= 30 && snapshot?.rsi < 35) matches = true;
        if (rule.label === 'RSI 35-45' && snapshot?.rsi >= 35 && snapshot?.rsi < 45) matches = true;
        if (rule.label === 'RSI 45-55' && snapshot?.rsi >= 45 && snapshot?.rsi < 55) matches = true;
        if (rule.label === 'RSI>55' && snapshot?.rsi >= 55) matches = true;
        break;

      case 'bb':
        if (rule.label === 'BB<10%' && snapshot?.bbPosition < 0.1) matches = true;
        if (rule.label === 'BB 10-30%' && snapshot?.bbPosition >= 0.1 && snapshot?.bbPosition < 0.3) matches = true;
        if (rule.label === 'BB 30-50%' && snapshot?.bbPosition >= 0.3 && snapshot?.bbPosition < 0.5) matches = true;
        if (rule.label === 'BB 50-70%' && snapshot?.bbPosition >= 0.5 && snapshot?.bbPosition < 0.7) matches = true;
        if (rule.label === 'BB>70%' && snapshot?.bbPosition >= 0.7) matches = true;
        break;

      case 'hour':
        const bucketStart = parseInt(rule.label);
        if (!isNaN(bucketStart) && hour >= bucketStart && hour < bucketStart + 3) matches = true;
        // 라벨 파싱 보정
        if (rule.label.includes(`${hour}-`) || rule.label.includes(`${Math.floor(hour / 3) * 3}-`)) {
          const [start] = rule.label.match(/\d+/) || [];
          if (start && hour >= parseInt(start) && hour < parseInt(start) + 3) matches = true;
        }
        break;

      case 'regime':
        if (rule.label === regime) matches = true;
        break;

      case 'symbol':
        if (symbol?.replace('/KRW', '') === rule.label) matches = true;
        break;
    }

    if (matches) {
      if (rule.action === 'block') {
        blocked.push(`[BLOCK] ${rule.type}:${rule.label} — ${rule.reason}`);
      } else {
        warnings.push(`[WARN] ${rule.type}:${rule.label} — ${rule.reason}`);
      }
    }
  }

  return {
    blocked: blocked.length > 0,
    warnings,
    reasons: [...blocked, ...warnings],
  };
}

// ─── 내부 함수 ───

function matchBuySell(trades) {
  const pairs = [];
  const buyMap = {}; // symbol → [buys]

  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!buyMap[t.symbol]) buyMap[t.symbol] = [];
      buyMap[t.symbol].push(t);
    } else if (t.action === 'SELL' && t.pnl != null) {
      const buys = buyMap[t.symbol];
      if (buys && buys.length > 0) {
        const buy = buys.shift();
        pairs.push({
          symbol: t.symbol,
          buyTime: buy.timestamp,
          sellTime: t.timestamp,
          buyPrice: buy.price,
          sellPrice: t.price,
          pnl: t.pnl,
          buySnapshot: buy.snapshot || {},
          regime: buy.regime || 'unknown',
          holdMs: t.timestamp - buy.timestamp,
        });
      }
    }
  }

  return pairs;
}

module.exports = { analyzeLossPatterns, checkLossPattern };
