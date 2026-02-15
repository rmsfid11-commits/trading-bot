/**
 * 멀티 타임프레임 분석 (Multi-Timeframe Analysis)
 *
 * 5분봉: 진입 타이밍 (단기)
 * 1시간봉: 중기 추세
 * 4시간봉: 장기 추세 방향
 *
 * 모든 타임프레임이 같은 방향이면 강한 시그널
 */

const { calculateRSI } = require('./rsi');
const { calculateBollinger } = require('./bollinger');
const { calculateMACD } = require('./macd');

/**
 * 단일 타임프레임 추세 분석
 * @returns { trend: 'up'|'down'|'neutral', strength: 0~1, rsi, macd }
 */
function analyzeTrend(candles) {
  if (!candles || candles.length < 30) {
    return { trend: 'neutral', strength: 0, rsi: 50, macdTrend: 'FLAT' };
  }

  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes) || 50;
  const macd = calculateMACD(candles);
  const bollinger = calculateBollinger(closes);

  let bullPoints = 0;
  let bearPoints = 0;

  // RSI 방향
  if (rsi < 40) bullPoints += 1;       // 과매도 = 반등 가능
  else if (rsi > 60) bearPoints += 1;  // 과매수 = 하락 가능

  // MACD 방향
  if (macd?.trend === 'UP') bullPoints += 1;
  if (macd?.trend === 'DOWN') bearPoints += 1;
  if (macd?.bullish) bullPoints += 0.5;
  if (macd?.bearish) bearPoints += 0.5;

  // 이동평균 기울기 (최근 10봉)
  if (closes.length >= 10) {
    const sma10now = closes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const sma10prev = closes.slice(-10, -5).reduce((s, v) => s + v, 0) / 5;
    if (sma10now > sma10prev * 1.002) bullPoints += 1;
    else if (sma10now < sma10prev * 0.998) bearPoints += 1;
  }

  // 볼린저 위치
  if (bollinger) {
    const pos = (closes[closes.length - 1] - bollinger.lower) / (bollinger.upper - bollinger.lower);
    if (pos < 0.3) bullPoints += 0.5;   // 하단 → 반등 기대
    if (pos > 0.7) bearPoints += 0.5;   // 상단 → 하락 기대
  }

  const total = bullPoints + bearPoints;
  let trend, strength;

  if (total === 0) {
    trend = 'neutral';
    strength = 0;
  } else if (bullPoints > bearPoints) {
    trend = 'up';
    strength = Math.min(1, (bullPoints - bearPoints) / 3);
  } else if (bearPoints > bullPoints) {
    trend = 'down';
    strength = Math.min(1, (bearPoints - bullPoints) / 3);
  } else {
    trend = 'neutral';
    strength = 0;
  }

  return {
    trend,
    strength: Math.round(strength * 100) / 100,
    rsi: Math.round(rsi * 10) / 10,
    macdTrend: macd?.trend || 'FLAT',
  };
}

/**
 * 멀티 타임프레임 종합 분석
 * @param {Object} candlesByTf - { '5m': [...], '1h': [...], '4h': [...] }
 * @returns { signal, alignment, details }
 */
function analyzeMultiTimeframe(candlesByTf) {
  const tf5m = candlesByTf['5m'] ? analyzeTrend(candlesByTf['5m']) : null;
  const tf1h = candlesByTf['1h'] ? analyzeTrend(candlesByTf['1h']) : null;
  const tf4h = candlesByTf['4h'] ? analyzeTrend(candlesByTf['4h']) : null;

  const trends = [tf5m, tf1h, tf4h].filter(Boolean);
  if (trends.length === 0) {
    return { signal: 'neutral', alignment: 0, boost: 0, details: {} };
  }

  // 방향 집계
  const upCount = trends.filter(t => t.trend === 'up').length;
  const downCount = trends.filter(t => t.trend === 'down').length;
  const totalTf = trends.length;

  // 정렬도: 모든 TF가 같은 방향이면 1.0
  const alignment = Math.max(upCount, downCount) / totalTf;

  let signal = 'neutral';
  let boost = 0;

  if (upCount === totalTf) {
    signal = 'strong_buy';
    boost = 1.5; // 매수 점수에 1.5 추가
  } else if (downCount === totalTf) {
    signal = 'strong_sell';
    boost = 1.5;
  } else if (upCount >= 2 && totalTf >= 2) {
    signal = 'buy';
    boost = 0.8;
  } else if (downCount >= 2 && totalTf >= 2) {
    signal = 'sell';
    boost = 0.8;
  } else if (upCount === 1 && downCount === 0) {
    signal = 'lean_buy';
    boost = 0.3;
  } else if (downCount === 1 && upCount === 0) {
    signal = 'lean_sell';
    boost = 0.3;
  }

  // 장기(4h)가 반대방향이면 부스트 감쇄
  if (tf4h) {
    if ((signal.includes('buy') && tf4h.trend === 'down') ||
        (signal.includes('sell') && tf4h.trend === 'up')) {
      boost *= 0.3; // 장기 추세 반대 → 대폭 감쇄
    }
  }

  return {
    signal,
    alignment: Math.round(alignment * 100) / 100,
    boost: Math.round(boost * 100) / 100,
    details: {
      '5m': tf5m,
      '1h': tf1h,
      '4h': tf4h,
    },
  };
}

module.exports = { analyzeTrend, analyzeMultiTimeframe };
