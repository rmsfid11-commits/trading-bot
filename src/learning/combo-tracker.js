/**
 * 시그널 조합 승률 추적기 (Combo Tracker)
 *
 * 어떤 시그널 조합이 수익을 냈는지 추적해서
 * 낮은 승률 조합은 매수를 억제하고, 높은 승률 조합은 가중치를 높임
 *
 * 매수 이유(reason)에서 핵심 시그널을 추출 → 조합 키 생성
 * 예: "RSI+BB+VOL" → 과거 승률 70% → buyScore 보너스
 *     "RSI만" → 과거 승률 20% → buyScore 패널티 또는 매수 차단
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_COMBO_PATH = path.join(__dirname, '../../logs/combo-stats.json');
const MIN_TRADES_FOR_ADJUST = 5; // 최소 5거래 이상 있어야 조절

// ─── 시그널 키 추출 ───

const SIGNAL_KEYWORDS = [
  { key: 'RSI', patterns: [/rsi|RSI|과매도|과매수/i] },
  { key: 'BB', patterns: [/볼린저|bollinger|볼밴|하단|상단/i] },
  { key: 'VOL', patterns: [/거래량|volume/i] },
  { key: 'MACD', patterns: [/macd|MACD|골든|데드/i] },
  { key: 'MTF', patterns: [/MTF|멀티|정렬/i] },
  { key: 'SENT', patterns: [/감성|sentiment|긍정|부정/i] },
  { key: 'PAT', patterns: [/패턴|망치|도지|engulf|hammer|doji|star|soldier|crow/i] },
  { key: 'CHART', patterns: [/삼각|이중|컵|어깨|쐐기|triangle|double|cup|shoulder|wedge/i] },
];

function extractComboKey(reason) {
  if (!reason) return 'UNKNOWN';
  const found = [];
  for (const sig of SIGNAL_KEYWORDS) {
    for (const pat of sig.patterns) {
      if (pat.test(reason)) {
        found.push(sig.key);
        break;
      }
    }
  }
  return found.length > 0 ? found.sort().join('+') : 'OTHER';
}

// ─── 콤보 통계 로드/저장 ───

function loadComboStats(logDir = null) {
  try {
    const comboPath = logDir ? path.join(logDir, 'combo-stats.json') : DEFAULT_COMBO_PATH;
    if (!fs.existsSync(comboPath)) return {};
    return JSON.parse(fs.readFileSync(comboPath, 'utf-8'));
  } catch { return {}; }
}

function saveComboStats(stats, logDir = null) {
  const comboPath = logDir ? path.join(logDir, 'combo-stats.json') : DEFAULT_COMBO_PATH;
  const dir = path.dirname(comboPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(comboPath, JSON.stringify(stats, null, 2), 'utf-8');
}

// ─── 거래 결과 기록 ───

/**
 * 매도 시 호출: 해당 시그널 조합의 성과 기록
 * @param {string} buyReason - 매수 시그널 이유
 * @param {number} pnlPct - 수익률 (%)
 * @param {Object} snapshot - 매수 시점 스냅샷 (buyScore 등)
 */
function recordComboResult(buyReason, pnlPct, snapshot = {}, logDir = null) {
  const stats = loadComboStats(logDir);
  const key = extractComboKey(buyReason);

  if (!stats[key]) {
    stats[key] = {
      combo: key,
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      avgBuyScore: 0,
      recentPnls: [], // 최근 20건
    };
  }

  const s = stats[key];
  s.trades++;
  if (pnlPct > 0) s.wins++;
  else s.losses++;
  s.totalPnl += pnlPct;

  // 이동평균 buyScore 업데이트
  const buyScore = snapshot.buyScore || 0;
  s.avgBuyScore = (s.avgBuyScore * (s.trades - 1) + buyScore) / s.trades;

  // 최근 20건 수익률 기록
  s.recentPnls.push(Math.round(pnlPct * 100) / 100);
  if (s.recentPnls.length > 20) s.recentPnls = s.recentPnls.slice(-20);

  // 파생 통계 계산
  s.winRate = Math.round((s.wins / s.trades) * 100);
  s.avgPnl = Math.round((s.totalPnl / s.trades) * 100) / 100;
  s.updatedAt = Date.now();

  saveComboStats(stats, logDir);
  return s;
}

// ─── 매수 스코어 조절 ───

/**
 * 시그널 조합의 과거 성과에 따라 buyScore 보정값 계산
 * @param {string} buyReason - 현재 매수 시그널 이유
 * @returns {{ adjustment, comboKey, winRate, trades, block }}
 */
function getComboAdjustment(buyReason, logDir = null) {
  const stats = loadComboStats(logDir);
  const key = extractComboKey(buyReason);
  const s = stats[key];

  // 데이터 부족하면 보정 없음
  if (!s || s.trades < MIN_TRADES_FOR_ADJUST) {
    return { adjustment: 0, comboKey: key, winRate: null, trades: s?.trades || 0, block: false };
  }

  // 승률 기반 보정
  let adjustment = 0;
  let block = false;

  if (s.winRate >= 60) {
    // 높은 승률: 보너스 +0.3 ~ +1.0
    adjustment = Math.min(1.0, (s.winRate - 50) * 0.02);
  } else if (s.winRate >= 40) {
    // 보통 승률: 소폭 보정
    adjustment = (s.winRate - 50) * 0.01; // -0.1 ~ +0.1
  } else if (s.winRate >= 25) {
    // 낮은 승률: 패널티 -0.3 ~ -0.5
    adjustment = -(50 - s.winRate) * 0.02;
  } else {
    // 매우 낮은 승률 (25% 미만): 매수 차단
    adjustment = -1.0;
    block = true;
  }

  // 최근 성과 반영 (최근 5건 연속 손실이면 추가 패널티)
  if (s.recentPnls.length >= 5) {
    const recent5 = s.recentPnls.slice(-5);
    const recentLosses = recent5.filter(p => p <= 0).length;
    if (recentLosses >= 5) {
      adjustment -= 0.5;
      block = true; // 최근 5연속 손실 → 차단
    } else if (recentLosses >= 4) {
      adjustment -= 0.3;
    }
  }

  return {
    adjustment: Math.round(adjustment * 100) / 100,
    comboKey: key,
    winRate: s.winRate,
    trades: s.trades,
    block,
    avgPnl: s.avgPnl,
  };
}

// ─── 동적 최소 매수 스코어 계산 ───

/**
 * 전체 콤보 통계 기반으로 최적 최소 매수 점수 계산
 * @returns {{ minBuyScore, confidence }}
 */
function getOptimalMinBuyScore(logDir = null) {
  const stats = loadComboStats(logDir);
  const combos = Object.values(stats).filter(s => s.trades >= MIN_TRADES_FOR_ADJUST);

  if (combos.length === 0) {
    return { minBuyScore: 2.0, confidence: 0, reason: '데이터 부족 (기본값 2.0)' };
  }

  // 각 조합의 avgBuyScore별 승률을 분석
  // buyScore가 높을수록 승률이 높은지 확인
  const scoreWinMap = {}; // buyScore 구간별 승률

  for (const c of combos) {
    const bucket = Math.round(c.avgBuyScore * 2) / 2; // 0.5 단위 버킷
    if (!scoreWinMap[bucket]) scoreWinMap[bucket] = { wins: 0, total: 0 };
    scoreWinMap[bucket].wins += c.wins;
    scoreWinMap[bucket].total += c.trades;
  }

  // 전체 평균 승률
  const totalWins = combos.reduce((s, c) => s + c.wins, 0);
  const totalTrades = combos.reduce((s, c) => s + c.trades, 0);
  const avgWinRate = totalTrades > 0 ? totalWins / totalTrades : 0.5;

  // 수익 나는 조합의 평균 buyScore를 최소 기준으로
  const profitCombos = combos.filter(c => c.avgPnl > 0);
  const lossCombos = combos.filter(c => c.avgPnl <= 0);

  let minBuyScore = 2.0; // 기본값

  if (profitCombos.length > 0) {
    const avgProfitScore = profitCombos.reduce((s, c) => s + c.avgBuyScore, 0) / profitCombos.length;
    const avgLossScore = lossCombos.length > 0
      ? lossCombos.reduce((s, c) => s + c.avgBuyScore, 0) / lossCombos.length
      : 0;

    // 수익 조합의 평균 점수 - 마진 → 최소 매수 기준
    minBuyScore = Math.max(1.5, Math.min(4.0, avgProfitScore * 0.8));

    // 전체 승률이 낮으면 기준을 높임
    if (avgWinRate < 0.35) {
      minBuyScore = Math.min(4.0, minBuyScore + 0.5);
    } else if (avgWinRate > 0.55) {
      minBuyScore = Math.max(1.5, minBuyScore - 0.3);
    }
  }

  const confidence = Math.min(1, totalTrades / 100);

  return {
    minBuyScore: Math.round(minBuyScore * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    totalCombos: combos.length,
    avgWinRate: Math.round(avgWinRate * 100),
    reason: `${combos.length}개 조합 분석, 전체 승률 ${Math.round(avgWinRate * 100)}%`,
  };
}

// ─── 콤보 통계 전체 조회 ───

function getAllComboStats(logDir = null) {
  const stats = loadComboStats(logDir);
  return Object.values(stats)
    .sort((a, b) => b.trades - a.trades)
    .map(s => ({
      combo: s.combo,
      trades: s.trades,
      winRate: s.winRate,
      avgPnl: s.avgPnl,
      avgBuyScore: Math.round(s.avgBuyScore * 100) / 100,
      recentTrend: getRecentTrend(s.recentPnls),
    }));
}

function getRecentTrend(pnls) {
  if (!pnls || pnls.length < 3) return 'unknown';
  const recent = pnls.slice(-5);
  const wins = recent.filter(p => p > 0).length;
  if (wins >= 4) return 'improving';
  if (wins <= 1) return 'declining';
  return 'stable';
}

module.exports = {
  extractComboKey,
  recordComboResult,
  getComboAdjustment,
  getOptimalMinBuyScore,
  getAllComboStats,
  loadComboStats,
};
