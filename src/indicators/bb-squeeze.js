/**
 * 볼린저 밴드 스퀴즈 감지 (BB Squeeze)
 *
 * BB가 켈트너 채널 안으로 수축하면 "스퀴즈" 상태
 * → 에너지 축적 → 돌파 시 강한 방향성 매매 기회
 *
 * 스퀴즈 해제(fire) 시점이 진입 타이밍
 * - 모멘텀 양수 → 상방 돌파 (매수)
 * - 모멘텀 음수 → 하방 돌파 (매도)
 */

function detectBBSqueeze(candles, opts = {}) {
  const {
    bbPeriod = 20,
    bbStdDev = 2,
    kcPeriod = 20,
    kcMult = 1.5,
    momentumPeriod = 12,
  } = opts;

  if (!candles || candles.length < Math.max(bbPeriod, kcPeriod, momentumPeriod) + 5) {
    return { squeeze: false, fire: false, direction: 'neutral', score: 0, history: [] };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // 최근 N봉 스퀴즈 히스토리 (연속 스퀴즈 길이 파악용)
  const historyLen = 10;
  const squeezeHistory = [];

  for (let i = closes.length - historyLen; i < closes.length; i++) {
    if (i < bbPeriod) { squeezeHistory.push(false); continue; }

    const slice = closes.slice(i - bbPeriod + 1, i + 1);
    const hSlice = highs.slice(i - bbPeriod + 1, i + 1);
    const lSlice = lows.slice(i - bbPeriod + 1, i + 1);

    const bbW = calcBB(slice, bbPeriod, bbStdDev);
    const kcW = calcKC(slice, hSlice, lSlice, kcPeriod, kcMult);

    squeezeHistory.push(bbW.upper < kcW.upper && bbW.lower > kcW.lower);
  }

  // 현재 상태
  const currentSqueeze = squeezeHistory[squeezeHistory.length - 1];
  const prevSqueeze = squeezeHistory[squeezeHistory.length - 2];

  // 스퀴즈 해제 (fire): 이전 스퀴즈 → 현재 아님
  const fire = prevSqueeze && !currentSqueeze;

  // 연속 스퀴즈 봉 수 (길수록 에너지 축적 큼)
  let squeezeBars = 0;
  for (let i = squeezeHistory.length - 2; i >= 0; i--) {
    if (squeezeHistory[i]) squeezeBars++;
    else break;
  }

  // 모멘텀 (선형 회귀 기반 간소화: 최근 vs 이전 중간값 비교)
  const momentum = calcMomentum(closes, momentumPeriod);
  const prevMomentum = calcMomentum(closes.slice(0, -1), momentumPeriod);

  // 모멘텀 방향
  let direction = 'neutral';
  if (momentum > 0 && momentum > prevMomentum) direction = 'up';
  else if (momentum > 0) direction = 'up_weak';
  else if (momentum < 0 && momentum < prevMomentum) direction = 'down';
  else if (momentum < 0) direction = 'down_weak';

  // 밴드폭 백분위 (현재 밴드폭이 최근 100봉 대비 어느 수준인지)
  const bandwidths = [];
  for (let i = bbPeriod; i < closes.length; i++) {
    const slice = closes.slice(i - bbPeriod + 1, i + 1);
    const bb = calcBB(slice, bbPeriod, bbStdDev);
    if (bb.middle > 0) bandwidths.push((bb.upper - bb.lower) / bb.middle * 100);
  }
  const currentBW = bandwidths[bandwidths.length - 1] || 0;
  const sortedBW = [...bandwidths].sort((a, b) => a - b);
  const bwPercentile = sortedBW.length > 0
    ? Math.round((sortedBW.indexOf(sortedBW.reduce((closest, v) =>
        Math.abs(v - currentBW) < Math.abs(closest - currentBW) ? v : closest
      )) / sortedBW.length) * 100)
    : 50;

  // 점수 계산
  let score = 0;

  if (fire) {
    // 스퀴즈 해제 시점: 매수/매도 시그널
    const baseFire = 1.5;
    const barBonus = Math.min(1.0, squeezeBars * 0.15); // 연속 스퀴즈 길수록 보너스
    const bwBonus = bwPercentile < 20 ? 0.5 : 0; // 밴드폭 매우 좁았으면 보너스

    if (direction === 'up' || direction === 'up_weak') {
      score = baseFire + barBonus + bwBonus;
    } else if (direction === 'down' || direction === 'down_weak') {
      score = -(baseFire + barBonus + bwBonus);
    }
  } else if (currentSqueeze) {
    // 스퀴즈 진행 중: 준비 상태 (약한 시그널)
    if (squeezeBars >= 5 && bwPercentile < 15) {
      // 매우 긴 스퀴즈 + 극도로 좁은 밴드 → 곧 터질 확률 높음
      score = direction.includes('up') ? 0.3 : direction.includes('down') ? -0.3 : 0;
    }
  }

  return {
    squeeze: currentSqueeze,
    fire,
    direction,
    momentum: Math.round(momentum * 100) / 100,
    squeezeBars,
    bandwidthPercentile: bwPercentile,
    score: Math.round(score * 100) / 100,
    history: squeezeHistory,
  };
}

// ─── 내부 계산 함수 ───

function calcBB(closes, period, stdDev) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + std * stdDev, middle: mean, lower: mean - std * stdDev };
}

function calcKC(closes, highs, lows, period, mult) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const cSlice = closes.slice(-period);
  const mean = cSlice.reduce((s, v) => s + v, 0) / period;

  // ATR 계산
  let atrSum = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      i > 0 ? Math.abs(highs[i] - closes[i - 1]) : 0,
      i > 0 ? Math.abs(lows[i] - closes[i - 1]) : 0
    );
    atrSum += tr;
  }
  const atr = atrSum / period;

  return { upper: mean + atr * mult, middle: mean, lower: mean - atr * mult };
}

function calcMomentum(closes, period) {
  if (closes.length < period + 1) return 0;
  const recent = closes.slice(-period);
  // 간단한 선형 회귀 기울기
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  // 정규화: 현재 가격 대비 기울기 %
  const currentPrice = recent[n - 1];
  return currentPrice > 0 ? (slope / currentPrice) * 100 : 0;
}

module.exports = { detectBBSqueeze };
