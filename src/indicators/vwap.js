/**
 * VWAP (Volume Weighted Average Price) 계산
 *
 * 기관 투자자들이 사용하는 핵심 지표
 * - 가격이 VWAP 위에 있으면 매수세 우위
 * - 가격이 VWAP 아래에 있으면 매도세 우위
 * - VWAP에서 멀어질수록 평균 회귀 가능성 높음
 */

/**
 * VWAP 계산
 * @param {Array} candles - [{ high, low, close, volume }]
 * @returns {{ vwap, deviation, signal, score }}
 */
function calculateVWAP(candles) {
  if (!candles || candles.length < 20) return null;

  // 최근 세션 기준 (최근 60개 캔들 = 5시간 @5min)
  const sessionCandles = candles.slice(-60);

  let cumulativeTPV = 0; // 누적 (TP × Volume)
  let cumulativeVolume = 0;
  const vwapHistory = [];

  for (const c of sessionCandles) {
    const tp = (c.high + c.low + c.close) / 3; // Typical Price
    cumulativeTPV += tp * c.volume;
    cumulativeVolume += c.volume;
    if (cumulativeVolume > 0) {
      vwapHistory.push(cumulativeTPV / cumulativeVolume);
    }
  }

  if (cumulativeVolume === 0 || vwapHistory.length === 0) return null;

  const vwap = vwapHistory[vwapHistory.length - 1];
  const currentPrice = sessionCandles[sessionCandles.length - 1].close;

  // 가격과 VWAP의 편차 (%)
  const deviation = ((currentPrice - vwap) / vwap) * 100;

  // 표준편차 밴드 (VWAP ± 1σ, ± 2σ)
  let sumSqDev = 0;
  for (let i = 0; i < sessionCandles.length; i++) {
    const tp = (sessionCandles[i].high + sessionCandles[i].low + sessionCandles[i].close) / 3;
    if (i < vwapHistory.length) {
      sumSqDev += (tp - vwapHistory[i]) ** 2;
    }
  }
  const stdDev = Math.sqrt(sumSqDev / sessionCandles.length);

  // 시그널 생성
  let signal = 'neutral';
  let score = 0;

  if (currentPrice < vwap - stdDev * 1.5) {
    signal = 'strong_buy'; // VWAP -1.5σ 이하: 강한 매수
    score = 1.5;
  } else if (currentPrice < vwap - stdDev * 0.5) {
    signal = 'buy'; // VWAP -0.5σ 이하: 매수
    score = 0.8;
  } else if (currentPrice > vwap + stdDev * 1.5) {
    signal = 'strong_sell'; // VWAP +1.5σ 이상: 강한 매도
    score = -1.5;
  } else if (currentPrice > vwap + stdDev * 0.5) {
    signal = 'sell'; // VWAP +0.5σ 이상: 매도
    score = -0.8;
  }

  return {
    vwap: Math.round(vwap),
    deviation: Math.round(deviation * 100) / 100,
    stdDev: Math.round(stdDev),
    upperBand1: Math.round(vwap + stdDev),
    lowerBand1: Math.round(vwap - stdDev),
    upperBand2: Math.round(vwap + stdDev * 2),
    lowerBand2: Math.round(vwap - stdDev * 2),
    signal,
    score,
    price: currentPrice,
  };
}

module.exports = { calculateVWAP };
