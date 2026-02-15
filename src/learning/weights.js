/**
 * 동적 시그널 가중치 (Dynamic Signal Weighting)
 *
 * 학습된 시그널 조합별 성과에 따라 가중치를 조절합니다.
 * 승률 높은 시그널 → 가중치 UP, 낮은 시그널 → 가중치 DOWN
 */

const fs = require('fs');
const path = require('path');

const WEIGHTS_PATH = path.join(__dirname, '../../logs/signal-weights.json');

// 기본 가중치 (signals.js에서 사용하는 하드코딩 값 기준)
const DEFAULT_WEIGHTS = {
  RSI_BUY: 2.0,        // RSI 과매도
  RSI_SELL: 2.0,       // RSI 과매수
  BB_TOUCH_BUY: 2.0,   // 볼밴 하단 터치
  BB_NEAR_BUY: 1.0,    // 볼밴 하단 근접
  BB_SELL: 2.0,        // 볼밴 상단 터치
  VOL_BUY: 1.0,        // 거래량 매수
  VOL_SELL: 1.0,       // 거래량 매도
  MACD_BUY: 1.0,       // MACD 골든크로스
  MACD_SELL: 1.0,      // MACD 데드크로스
  MACD_TREND: 0.5,     // MACD 추세 보너스
};

const WEIGHT_BOUNDS = { min: 0.1, max: 4.0 }; // 가중치 허용 범위

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8'));
      return { ...DEFAULT_WEIGHTS, ...saved.weights };
    }
  } catch { }
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(weights, meta = {}) {
  try {
    const dir = path.dirname(WEIGHTS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify({
      weights,
      updatedAt: Date.now(),
      ...meta,
    }, null, 2), 'utf-8');
  } catch { }
}

/**
 * 학습 결과(시그널 조합별 성과)를 기반으로 가중치 업데이트
 *
 * @param {Object} reasonStats - analyzer.js의 analyzeByReason 결과
 * @param {number} learningRate - 학습률 (기본 0.1)
 */
function updateWeightsFromStats(reasonStats, learningRate = 0.1) {
  const current = loadWeights();

  // 시그널 조합의 성과를 개별 시그널에 배분
  const signalPerformance = {};

  for (const [reason, stat] of Object.entries(reasonStats)) {
    if (stat.trades < 2) continue; // 2건 미만 무시

    // 성과 점수: 승률(0~1) * 0.5 + 정규화된 평균손익 * 0.5
    const winScore = stat.winRate / 100;
    const pnlScore = Math.max(0, Math.min(1, (stat.avgPnl + 3) / 6)); // -3%→0, +3%→1
    const performance = winScore * 0.5 + pnlScore * 0.5;

    // 시그널 키워드 매핑
    const signals = mapReasonToSignals(reason);
    for (const sig of signals) {
      if (!signalPerformance[sig]) signalPerformance[sig] = { totalPerf: 0, count: 0 };
      signalPerformance[sig].totalPerf += performance;
      signalPerformance[sig].count++;
    }
  }

  // 가중치 업데이트
  for (const [sig, perf] of Object.entries(signalPerformance)) {
    if (!current[sig]) continue;
    const avgPerf = perf.totalPerf / perf.count;
    // 성과 0.5 기준: 0.5 이상이면 가중치 증가, 미만이면 감소
    const adjustment = (avgPerf - 0.5) * 2 * learningRate;
    current[sig] = clampWeight(current[sig] + adjustment);
  }

  saveWeights(current, { signalPerformance });
  return current;
}

/**
 * 종목별 전략 파라미터를 학습
 * 같은 종목이라도 다른 파라미터가 최적일 수 있음
 */
function getSymbolWeightAdjustment(symbol, symbolStats) {
  const stat = symbolStats?.[symbol];
  if (!stat || stat.trades < 3) return 1.0; // 데이터 부족 시 기본

  // 성과 좋은 종목: 가중치 약간 내려도 진입 (공격적)
  // 성과 나쁜 종목: 가중치 올려서 진입 까다롭게 (방어적)
  const score = stat.score || 50;
  if (score >= 70) return 0.85;  // 좋은 종목: 쉽게 진입
  if (score >= 50) return 1.0;   // 보통
  if (score >= 30) return 1.15;  // 나쁜 종목: 까다롭게
  return 1.3;                    // 매우 나쁜 종목: 매우 까다롭게
}

// ─── 내부 함수 ───

function mapReasonToSignals(reason) {
  const signals = [];
  const r = reason.toUpperCase();
  if (r.includes('RSI')) signals.push('RSI_BUY');
  if (r.includes('BB') || r.includes('볼린저') || r.includes('볼밴')) signals.push('BB_TOUCH_BUY');
  if (r.includes('VOL') || r.includes('거래량')) signals.push('VOL_BUY');
  if (r.includes('MACD') || r.includes('골든')) signals.push('MACD_BUY');
  return signals.length > 0 ? signals : ['RSI_BUY']; // 기본 매핑
}

function clampWeight(w) {
  return Math.round(Math.max(WEIGHT_BOUNDS.min, Math.min(WEIGHT_BOUNDS.max, w)) * 100) / 100;
}

module.exports = {
  DEFAULT_WEIGHTS,
  loadWeights,
  saveWeights,
  updateWeightsFromStats,
  getSymbolWeightAdjustment,
};
