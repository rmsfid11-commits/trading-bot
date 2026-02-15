const fs = require('fs');
const path = require('path');

const TRADES_PATH = path.join(__dirname, '../../logs/trades.jsonl');
const LEARNED_PATH = path.join(__dirname, '../../logs/learned-params.json');

// ─── trades.jsonl 파싱 + BUY-SELL 페어 매칭 ───

function loadTrades() {
  if (!fs.existsSync(TRADES_PATH)) return [];
  const lines = fs.readFileSync(TRADES_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function matchPairs(trades) {
  const openBuys = {}; // symbol → [buy, buy, ...]
  const pairs = [];

  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!openBuys[t.symbol]) openBuys[t.symbol] = [];
      openBuys[t.symbol].push(t);
    } else if (t.action === 'SELL' && openBuys[t.symbol]?.length) {
      const buy = openBuys[t.symbol].shift();
      const pnlPct = t.pnl != null
        ? t.pnl
        : ((t.price - buy.price) / buy.price) * 100;
      const holdMs = t.timestamp - buy.timestamp;
      pairs.push({
        symbol: t.symbol,
        buyTime: buy.timestamp,
        sellTime: t.timestamp,
        buyPrice: buy.price,
        sellPrice: t.price,
        pnlPct,
        holdMs,
        holdHours: holdMs / 3600000,
        buyReason: buy.reason || '',
        sellReason: t.reason || '',
        amount: buy.amount || t.amount || 0,
        win: pnlPct > 0,
      });
    }
  }
  return pairs;
}

// ─── 종목별 분석 ───

function analyzeBySymbol(pairs) {
  const map = {};
  for (const p of pairs) {
    if (!map[p.symbol]) map[p.symbol] = { symbol: p.symbol, trades: 0, wins: 0, totalPnl: 0, pnls: [] };
    const s = map[p.symbol];
    s.trades++;
    if (p.win) s.wins++;
    s.totalPnl += p.pnlPct;
    s.pnls.push(p.pnlPct);
  }
  for (const s of Object.values(map)) {
    s.winRate = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0;
    s.avgPnl = s.trades > 0 ? Math.round((s.totalPnl / s.trades) * 100) / 100 : 0;
    s.score = calcSymbolScore(s);
  }
  return map;
}

function calcSymbolScore(stat) {
  // 0~100 점수: 승률 40% + 평균손익 40% + 거래량 20%
  const winScore = Math.min(100, stat.winRate);
  const pnlScore = Math.min(100, Math.max(0, (stat.avgPnl + 5) * 10)); // -5% → 0, +5% → 100
  const volScore = Math.min(100, stat.trades * 10); // 10거래 → 100
  return Math.round(winScore * 0.4 + pnlScore * 0.4 + volScore * 0.2);
}

// ─── 시간대별 분석 ───

function analyzeByHour(pairs) {
  const hours = {};
  for (let h = 0; h < 24; h++) hours[h] = { hour: h, trades: 0, wins: 0, totalPnl: 0 };
  for (const p of pairs) {
    const h = new Date(p.buyTime).getHours();
    hours[h].trades++;
    if (p.win) hours[h].wins++;
    hours[h].totalPnl += p.pnlPct;
  }
  for (const h of Object.values(hours)) {
    h.winRate = h.trades > 0 ? Math.round((h.wins / h.trades) * 100) : 0;
    h.avgPnl = h.trades > 0 ? Math.round((h.totalPnl / h.trades) * 100) / 100 : 0;
  }
  return hours;
}

// ─── 시그널 조합별 분석 ───

function analyzeByReason(pairs) {
  const map = {};
  for (const p of pairs) {
    const key = normalizeReason(p.buyReason);
    if (!map[key]) map[key] = { reason: key, trades: 0, wins: 0, totalPnl: 0 };
    map[key].trades++;
    if (p.win) map[key].wins++;
    map[key].totalPnl += p.pnlPct;
  }
  for (const r of Object.values(map)) {
    r.winRate = r.trades > 0 ? Math.round((r.wins / r.trades) * 100) : 0;
    r.avgPnl = r.trades > 0 ? Math.round((r.totalPnl / r.trades) * 100) / 100 : 0;
  }
  return map;
}

function normalizeReason(reason) {
  if (!reason) return '기타';
  // 시그널 이유에서 핵심 키워드 추출
  const keywords = [];
  if (/rsi|RSI|과매도/i.test(reason)) keywords.push('RSI');
  if (/볼린저|bollinger|하단밴드/i.test(reason)) keywords.push('BB');
  if (/거래량|volume/i.test(reason)) keywords.push('VOL');
  if (/macd|MACD|골든/i.test(reason)) keywords.push('MACD');
  return keywords.length > 0 ? keywords.sort().join('+') : reason.slice(0, 20);
}

// ─── 요일별 분석 ───

function analyzeByDayOfWeek(pairs) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const map = {};
  for (let d = 0; d < 7; d++) map[d] = { day: days[d], dayNum: d, trades: 0, wins: 0, totalPnl: 0 };
  for (const p of pairs) {
    const d = new Date(p.buyTime).getDay();
    map[d].trades++;
    if (p.win) map[d].wins++;
    map[d].totalPnl += p.pnlPct;
  }
  for (const d of Object.values(map)) {
    d.winRate = d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0;
    d.avgPnl = d.trades > 0 ? Math.round((d.totalPnl / d.trades) * 100) / 100 : 0;
  }
  return map;
}

// ─── 보유시간 vs 수익률 ───

function analyzeHoldTime(pairs) {
  const buckets = [
    { label: '~30분', min: 0, max: 0.5 },
    { label: '30분~1시간', min: 0.5, max: 1 },
    { label: '1~2시간', min: 1, max: 2 },
    { label: '2~4시간', min: 2, max: 4 },
    { label: '4시간+', min: 4, max: Infinity },
  ];
  const result = buckets.map(b => ({ ...b, trades: 0, wins: 0, totalPnl: 0 }));
  for (const p of pairs) {
    const bucket = result.find(b => p.holdHours >= b.min && p.holdHours < b.max);
    if (bucket) {
      bucket.trades++;
      if (p.win) bucket.wins++;
      bucket.totalPnl += p.pnlPct;
    }
  }
  for (const b of result) {
    b.winRate = b.trades > 0 ? Math.round((b.wins / b.trades) * 100) : 0;
    b.avgPnl = b.trades > 0 ? Math.round((b.totalPnl / b.trades) * 100) / 100 : 0;
  }
  return result;
}

// ─── 파라미터 최적화 ───

function optimizeParams(pairs, currentStrategy) {
  if (pairs.length < 30) {
    return { params: null, confidence: 0, reason: `거래 수 부족 (${pairs.length}/30)` };
  }

  const ranges = {
    RSI_OVERSOLD: { min: 25, max: 45, step: 5, current: currentStrategy.RSI_OVERSOLD },
    RSI_OVERBOUGHT: { min: 60, max: 85, step: 5, current: currentStrategy.RSI_OVERBOUGHT },
    STOP_LOSS_PCT: { min: -5, max: -1, step: 0.5, current: currentStrategy.STOP_LOSS_PCT },
    TAKE_PROFIT_PCT: { min: 2, max: 10, step: 1, current: currentStrategy.TAKE_PROFIT_PCT },
    MAX_HOLD_HOURS: { min: 1, max: 8, step: 1, current: currentStrategy.MAX_HOLD_HOURS },
  };

  const best = {};
  const details = {};

  for (const [param, range] of Object.entries(ranges)) {
    let bestVal = range.current;
    let bestScore = -Infinity;

    for (let val = range.min; val <= range.max; val += range.step) {
      const score = simulateParam(pairs, param, val);
      if (score > bestScore) {
        bestScore = score;
        bestVal = Math.round(val * 100) / 100;
      }
    }
    best[param] = bestVal;
    details[param] = { from: range.current, to: bestVal, score: Math.round(bestScore * 100) / 100 };
  }

  // confidence: 데이터 양 + 일관성 기반
  const confidence = calcConfidence(pairs, details);

  return { params: best, confidence, details };
}

function simulateParam(pairs, param, value) {
  // 해당 파라미터로 과거 거래를 재평가
  let totalPnl = 0;
  let wins = 0;
  let count = 0;

  for (const p of pairs) {
    let include = true;
    let adjustedPnl = p.pnlPct;

    switch (param) {
      case 'STOP_LOSS_PCT':
        // 손절선에 걸렸을 경우의 시뮬레이션
        if (p.pnlPct < value) adjustedPnl = value;
        break;
      case 'TAKE_PROFIT_PCT':
        // 익절선에 걸렸을 경우의 시뮬레이션
        if (p.pnlPct > value) adjustedPnl = value;
        break;
      case 'MAX_HOLD_HOURS':
        // 보유시간 초과 시 중간 정도 손익으로 추정
        if (p.holdHours > value) adjustedPnl = p.pnlPct * (value / p.holdHours);
        break;
      case 'RSI_OVERSOLD':
        // RSI 과매도 기준이 낮을수록 진입이 까다로워짐 → 승률 높지만 기회 감소
        include = true; // 과거 데이터로는 정확한 시뮬레이션 한계, 승률 기반 점수
        break;
      case 'RSI_OVERBOUGHT':
        include = true;
        break;
    }

    if (include) {
      totalPnl += adjustedPnl;
      if (adjustedPnl > 0) wins++;
      count++;
    }
  }

  if (count === 0) return -Infinity;
  const winRate = wins / count;
  const avgPnl = totalPnl / count;
  // 점수 = 평균손익 * 0.6 + 승률보너스 * 0.4
  return avgPnl * 0.6 + (winRate * 10 - 5) * 0.4;
}

function calcConfidence(pairs, details) {
  // 데이터 양: 30→0.3, 100→0.7, 200+→1.0
  const dataScore = Math.min(1, pairs.length / 200);
  // 일관성: 최적값이 현재와 가까우면 높음
  let changeScore = 0;
  let paramCount = 0;
  for (const d of Object.values(details)) {
    if (d.from === 0) continue;
    const changePct = Math.abs((d.to - d.from) / d.from);
    changeScore += 1 - Math.min(1, changePct * 2); // 큰 변경 → 낮은 신뢰도
    paramCount++;
  }
  changeScore = paramCount > 0 ? changeScore / paramCount : 0.5;

  return Math.round((dataScore * 0.6 + changeScore * 0.4) * 100) / 100;
}

// ─── 블랙리스트 ───

function getBlacklist(symbolStats, threshold = 25) {
  const blacklist = [];
  for (const [symbol, stat] of Object.entries(symbolStats)) {
    if (stat.trades >= 3 && stat.winRate < threshold) {
      blacklist.push(symbol);
    }
  }
  return blacklist;
}

// ─── 선호/비선호 시간대 ───

function getPreferredHours(hourStats) {
  const preferred = [];
  const avoid = [];
  for (const [hour, stat] of Object.entries(hourStats)) {
    if (stat.trades < 2) continue;
    if (stat.avgPnl > 0 && stat.winRate >= 50) preferred.push(Number(hour));
    if (stat.avgPnl < -1 || stat.winRate < 30) avoid.push(Number(hour));
  }
  return { preferred, avoid };
}

// ─── 결과 저장 ───

function saveLearnedParams(result) {
  const dir = path.dirname(LEARNED_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEARNED_PATH, JSON.stringify(result, null, 2), 'utf-8');
}

function loadLearnedParams() {
  try {
    if (!fs.existsSync(LEARNED_PATH)) return null;
    return JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf-8'));
  } catch { return null; }
}

// ─── 통합 분석 실행 ───

function runAnalysis(currentStrategy) {
  const defaultStrategy = currentStrategy || {
    RSI_OVERSOLD: 40, RSI_OVERBOUGHT: 70,
    STOP_LOSS_PCT: -2, TAKE_PROFIT_PCT: 5, MAX_HOLD_HOURS: 4,
  };

  const trades = loadTrades();
  const pairs = matchPairs(trades);

  const symbolStats = analyzeBySymbol(pairs);
  const hourStats = analyzeByHour(pairs);
  const reasonStats = analyzeByReason(pairs);
  const dayStats = analyzeByDayOfWeek(pairs);
  const holdTimeStats = analyzeHoldTime(pairs);
  const optimization = optimizeParams(pairs, defaultStrategy);
  const blacklist = getBlacklist(symbolStats);
  const { preferred, avoid } = getPreferredHours(hourStats);

  // 종목별 점수
  const symbolScores = {};
  for (const [sym, stat] of Object.entries(symbolStats)) {
    symbolScores[sym] = stat.score;
  }

  const result = {
    updatedAt: Date.now(),
    tradesAnalyzed: pairs.length,
    totalTrades: trades.length,
    params: optimization.params,
    blacklist,
    preferredHours: preferred,
    avoidHours: avoid,
    symbolScores,
    confidence: optimization.confidence,
    analysis: {
      bySymbol: symbolStats,
      byHour: hourStats,
      byReason: reasonStats,
      byDayOfWeek: dayStats,
      byHoldTime: holdTimeStats,
      optimization,
    },
  };

  saveLearnedParams(result);
  return result;
}

module.exports = {
  loadTrades,
  matchPairs,
  analyzeBySymbol,
  analyzeByHour,
  analyzeByReason,
  analyzeByDayOfWeek,
  analyzeHoldTime,
  optimizeParams,
  getBlacklist,
  getPreferredHours,
  saveLearnedParams,
  loadLearnedParams,
  runAnalysis,
};
