/**
 * 시장 레짐 감지 (Market Regime Detection)
 *
 * 3가지 시장 상태:
 * - trending: 추세장 (ADX 높음, 이동평균 방향 뚜렷)
 * - ranging:  횡보장 (ADX 낮음, 볼린저 좁음)
 * - volatile: 급변장 (ATR 급등, 변동성 폭발)
 */

function detectRegime(candles) {
  if (!candles || candles.length < 30) {
    return { regime: 'unknown', confidence: 0, indicators: {} };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // ADX 계산 (14기간)
  const adx = calculateADX(highs, lows, closes, 14);

  // ATR 계산 (14기간)
  const atr = calculateATR(highs, lows, closes, 14);
  const atrPct = (atr / closes[closes.length - 1]) * 100;

  // ATR 변화율: 최근 ATR vs 20봉 전 ATR
  const atrHistory = calculateATRHistory(highs, lows, closes, 14, 20);
  const atrChange = atrHistory.length >= 2
    ? (atrHistory[atrHistory.length - 1] / atrHistory[0] - 1) * 100
    : 0;

  // 볼린저 밴드 폭
  const bbWidth = calculateBBWidth(closes, 20);

  // 이동평균 방향
  const sma20 = sma(closes, 20);
  const sma50 = closes.length >= 50 ? sma(closes, 50) : sma20;
  const trendDirection = sma20 > sma50 ? 'up' : sma20 < sma50 ? 'down' : 'flat';

  // 이동평균 기울기 (최근 5봉)
  const recentCloses = closes.slice(-5);
  const smaSlope = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0] * 100;

  // 레짐 판정
  let regime, confidence;

  if (atrChange > 50 || atrPct > 3) {
    // 급변장: ATR 50% 이상 증가 또는 ATR이 가격의 3% 이상
    regime = 'volatile';
    confidence = Math.min(1, (atrChange / 100 + atrPct / 5) / 2);
  } else if (adx > 25 && Math.abs(smaSlope) > 0.3) {
    // 추세장: ADX > 25 + 뚜렷한 방향
    regime = 'trending';
    confidence = Math.min(1, (adx - 20) / 30);
  } else if (adx < 20 && bbWidth < 3) {
    // 횡보장: ADX < 20 + 볼린저 좁음
    regime = 'ranging';
    confidence = Math.min(1, (20 - adx) / 15);
  } else {
    // 애매한 경우: 가장 가까운 레짐으로
    if (adx > 22) {
      regime = 'trending';
      confidence = 0.3;
    } else {
      regime = 'ranging';
      confidence = 0.3;
    }
  }

  return {
    regime,
    confidence: Math.round(confidence * 100) / 100,
    indicators: {
      adx: Math.round(adx * 10) / 10,
      atrPct: Math.round(atrPct * 100) / 100,
      atrChange: Math.round(atrChange * 10) / 10,
      bbWidth: Math.round(bbWidth * 100) / 100,
      trendDirection,
      smaSlope: Math.round(smaSlope * 100) / 100,
    },
  };
}

/**
 * 레짐별 추천 파라미터 조정 비율
 */
function getRegimeAdjustments(regime) {
  switch (regime) {
    case 'trending':
      // 추세장: 추세 따라가기, 익절 넓게, 손절 타이트하게
      return {
        RSI_OVERSOLD_MULT: 0.9,     // RSI 기준 좀 더 까다롭게
        RSI_OVERBOUGHT_MULT: 1.05,  // 과매수 늦게 판단 (추세 존중)
        STOP_LOSS_MULT: 0.8,        // 손절 타이트하게
        TAKE_PROFIT_MULT: 1.4,      // 익절 넓게 (추세 탈 때)
        MAX_HOLD_MULT: 1.3,         // 보유시간 길게
        BUY_THRESHOLD_MULT: 0.9,    // 매수 진입 쉽게
      };
    case 'ranging':
      // 횡보장: 역추세, 빠른 익절, 느슨한 손절
      return {
        RSI_OVERSOLD_MULT: 1.1,     // RSI 기준 느슨하게
        RSI_OVERBOUGHT_MULT: 0.95,  // 과매수 빨리 판단
        STOP_LOSS_MULT: 1.2,        // 손절 넓게 (변동 견딤)
        TAKE_PROFIT_MULT: 0.7,      // 익절 빨리
        MAX_HOLD_MULT: 0.7,         // 보유시간 짧게
        BUY_THRESHOLD_MULT: 1.0,
      };
    case 'volatile':
      // 급변장: 보수적, 진입 까다롭게, 빠른 탈출
      return {
        RSI_OVERSOLD_MULT: 0.8,     // RSI 매우 까다롭게
        RSI_OVERBOUGHT_MULT: 0.9,
        STOP_LOSS_MULT: 0.7,        // 손절 타이트
        TAKE_PROFIT_MULT: 1.2,      // 익절은 넉넉히
        MAX_HOLD_MULT: 0.5,         // 보유시간 최소
        BUY_THRESHOLD_MULT: 1.3,    // 매수 기준 높게
      };
    default:
      return {
        RSI_OVERSOLD_MULT: 1.0, RSI_OVERBOUGHT_MULT: 1.0,
        STOP_LOSS_MULT: 1.0, TAKE_PROFIT_MULT: 1.0,
        MAX_HOLD_MULT: 1.0, BUY_THRESHOLD_MULT: 1.0,
      };
  }
}

// ─── 내부 계산 함수들 ───

function sma(data, period) {
  const slice = data.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function calculateATR(highs, lows, closes, period) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function calculateATRHistory(highs, lows, closes, period, lookback) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const history = [];
  for (let i = period; i <= trs.length; i++) {
    const slice = trs.slice(i - period, i);
    history.push(slice.reduce((s, v) => s + v, 0) / period);
  }
  return history.slice(-lookback);
}

function calculateADX(highs, lows, closes, period) {
  if (closes.length < period * 2) return 15; // 데이터 부족 시 기본값

  const plusDM = [];
  const minusDM = [];
  const trs = [];

  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  // Smoothed averages (Wilder smoothing)
  const smooth = (arr, p) => {
    const result = [arr.slice(0, p).reduce((s, v) => s + v, 0)];
    for (let i = p; i < arr.length; i++) {
      result.push(result[result.length - 1] - result[result.length - 1] / p + arr[i]);
    }
    return result;
  };

  const smoothTR = smooth(trs, period);
  const smoothPDM = smooth(plusDM, period);
  const smoothMDM = smooth(minusDM, period);

  const diPlus = [];
  const diMinus = [];
  const dx = [];

  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { diPlus.push(0); diMinus.push(0); dx.push(0); continue; }
    const dp = (smoothPDM[i] / smoothTR[i]) * 100;
    const dm = (smoothMDM[i] / smoothTR[i]) * 100;
    diPlus.push(dp);
    diMinus.push(dm);
    const sum = dp + dm;
    dx.push(sum === 0 ? 0 : Math.abs(dp - dm) / sum * 100);
  }

  if (dx.length < period) return 15;

  // ADX = smoothed DX
  let adx = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return adx;
}

function calculateBBWidth(closes, period) {
  if (closes.length < period) return 5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return mean > 0 ? (std * 4 / mean * 100) : 5; // 밴드 폭 %
}

module.exports = { detectRegime, getRegimeAdjustments };
