/**
 * ATR (Average True Range) 계산
 *
 * 변동성 측정 지표 → 동적 손절/익절에 사용
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = SMA(True Range, period)
 */

/**
 * ATR 계산
 * @param {Array} candles - [{ high, low, close }]
 * @param {number} period - 기본 14
 * @returns {{ atr, atrPct, atrHistory }}
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // EMA 방식 ATR (더 반응적)
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrHistory = [atr];

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrHistory.push(atr);
  }

  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;

  return {
    atr: Math.round(atr * 100) / 100,
    atrPct: Math.round(atrPct * 1000) / 1000,
    atrHistory,
  };
}

/**
 * ATR 기반 동적 손절/익절 계산
 * @param {Array} candles
 * @param {Object} opts - { slMult, tpMult, minSL, maxSL, minTP, maxTP }
 * @returns {{ stopLossPct, takeProfitPct, atrPct }}
 */
function getDynamicSLTP(candles, opts = {}) {
  const {
    slMult = 1.2,   // 손절 = ATR × 1.2
    tpMult = 2.0,   // 익절 = ATR × 2.0
    minSL = -0.8,   // 최소 손절
    maxSL = -3.0,   // 최대 손절
    minTP = 1.0,    // 최소 익절
    maxTP = 5.0,    // 최대 익절
  } = opts;

  const atrData = calculateATR(candles);
  if (!atrData) {
    return { stopLossPct: -1.5, takeProfitPct: 2.5, atrPct: 0 };
  }

  let sl = -(atrData.atrPct * slMult);
  let tp = atrData.atrPct * tpMult;

  // 바운드 적용
  sl = Math.max(maxSL, Math.min(minSL, sl));
  tp = Math.max(minTP, Math.min(maxTP, tp));

  return {
    stopLossPct: Math.round(sl * 100) / 100,
    takeProfitPct: Math.round(tp * 100) / 100,
    atrPct: atrData.atrPct,
  };
}

module.exports = { calculateATR, getDynamicSLTP };
