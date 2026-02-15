function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const closes = candles.map(c => c.close);
  if (closes.length < slowPeriod + signalPeriod) return null;

  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let result = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < data.length; i++) {
      result.push(data[i] * k + result[result.length - 1] * (1 - k));
    }
    return result;
  };

  const fastEMA = ema(closes, fastPeriod);
  const slowEMA = ema(closes, slowPeriod);

  const offset = slowPeriod - fastPeriod;
  const macdLine = [];
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);

  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  const histogram = macd - signal;
  const prevHistogram = macdLine.length >= 2 && signalLine.length >= 2
    ? macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]
    : 0;

  // ─── MACD 다이버전스 감지 ───
  const divergence = detectDivergence(closes, macdLine, 20);

  return {
    macd: Math.round(macd * 100) / 100,
    signal: Math.round(signal * 100) / 100,
    histogram: Math.round(histogram * 100) / 100,
    bullish: histogram > 0 && prevHistogram <= 0,
    bearish: histogram < 0 && prevHistogram >= 0,
    trend: histogram > 0 ? 'UP' : 'DOWN',
    divergence,
  };
}

/**
 * MACD 다이버전스 감지
 *
 * 강세 다이버전스: 가격은 저점 갱신 (Lower Low) 하지만 MACD는 고점 갱신 (Higher Low)
 *   → 하락 모멘텀 약화, 반등 가능성 높음 (강한 매수 시그널)
 *
 * 약세 다이버전스: 가격은 고점 갱신 (Higher High) 하지만 MACD는 저점 갱신 (Lower High)
 *   → 상승 모멘텀 약화, 하락 가능성 높음 (매도 시그널)
 *
 * @param {number[]} closes - 종가 배열
 * @param {number[]} macdLine - MACD 라인 배열
 * @param {number} lookback - 탐색 범위
 * @returns {{ type, score }}
 */
function detectDivergence(closes, macdLine, lookback = 20) {
  if (closes.length < lookback + 5 || macdLine.length < lookback + 5) {
    return { type: 'none', score: 0 };
  }

  // 최근 lookback 캔들에서 저점/고점 2개씩 찾기
  const recentCloses = closes.slice(-lookback);
  const alignedMacd = macdLine.slice(-lookback);

  // 로컬 저점 찾기 (3-bar swing low)
  const lows = [];
  const highs = [];
  for (let i = 2; i < recentCloses.length - 2; i++) {
    if (recentCloses[i] <= recentCloses[i - 1] && recentCloses[i] <= recentCloses[i - 2] &&
        recentCloses[i] <= recentCloses[i + 1] && recentCloses[i] <= recentCloses[i + 2]) {
      lows.push({ idx: i, price: recentCloses[i], macd: alignedMacd[i] });
    }
    if (recentCloses[i] >= recentCloses[i - 1] && recentCloses[i] >= recentCloses[i - 2] &&
        recentCloses[i] >= recentCloses[i + 1] && recentCloses[i] >= recentCloses[i + 2]) {
      highs.push({ idx: i, price: recentCloses[i], macd: alignedMacd[i] });
    }
  }

  // 강세 다이버전스: 가격 Lower Low + MACD Higher Low
  if (lows.length >= 2) {
    const prev = lows[lows.length - 2];
    const curr = lows[lows.length - 1];
    if (curr.price < prev.price && curr.macd > prev.macd) {
      // 최근 저점이 lookback의 후반부(최근)에 있어야 유효
      if (curr.idx >= lookback - 6) {
        return { type: 'bullish', score: 1.5 };
      }
    }
  }

  // 약세 다이버전스: 가격 Higher High + MACD Lower High
  if (highs.length >= 2) {
    const prev = highs[highs.length - 2];
    const curr = highs[highs.length - 1];
    if (curr.price > prev.price && curr.macd < prev.macd) {
      if (curr.idx >= lookback - 6) {
        return { type: 'bearish', score: -1.5 };
      }
    }
  }

  return { type: 'none', score: 0 };
}

module.exports = { calculateMACD, detectDivergence };
