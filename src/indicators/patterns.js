/**
 * 캔들스틱 패턴 인식
 *
 * 각 함수는 candles 배열의 마지막 N개를 분석하여
 * { name, type: 'bullish'|'bearish', strength: 1~3 } 반환
 */

function detectCandlePatterns(candles) {
  if (!candles || candles.length < 5) return [];

  const patterns = [];
  const c = candles.slice(-5); // 최근 5봉

  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  const prev2 = c[c.length - 3];

  const bodySize = (candle) => Math.abs(candle.close - candle.open);
  const totalRange = (candle) => candle.high - candle.low;
  const upperShadow = (candle) => candle.high - Math.max(candle.open, candle.close);
  const lowerShadow = (candle) => Math.min(candle.open, candle.close) - candle.low;
  const isBullish = (candle) => candle.close > candle.open;
  const isBearish = (candle) => candle.close < candle.open;

  const avgBody = c.slice(0, -1).reduce((s, x) => s + bodySize(x), 0) / (c.length - 1);
  const range = totalRange(last);

  // ─── 단일 캔들 패턴 ───

  // 도지 (Doji) — 몸통이 매우 작음 (전체 범위의 10% 이하)
  if (range > 0 && bodySize(last) / range < 0.1) {
    patterns.push({ name: '도지', type: 'reversal', strength: 1, emoji: '✝️' });
  }

  // 해머 (Hammer) — 하락장 후, 긴 아래꼬리, 작은 몸통 위쪽
  if (lowerShadow(last) >= bodySize(last) * 2 &&
      upperShadow(last) < bodySize(last) * 0.5 &&
      isBearish(prev)) {
    patterns.push({ name: '해머', type: 'bullish', strength: 2, emoji: '🔨' });
  }

  // 역해머 (Inverted Hammer) — 하락장 후, 긴 위꼬리
  if (upperShadow(last) >= bodySize(last) * 2 &&
      lowerShadow(last) < bodySize(last) * 0.5 &&
      isBearish(prev)) {
    patterns.push({ name: '역해머', type: 'bullish', strength: 1, emoji: '⬆️' });
  }

  // 교수형 (Hanging Man) — 상승장 후, 긴 아래꼬리 (해머와 반대 맥락)
  if (lowerShadow(last) >= bodySize(last) * 2 &&
      upperShadow(last) < bodySize(last) * 0.5 &&
      isBullish(prev) && isBullish(prev2)) {
    patterns.push({ name: '교수형', type: 'bearish', strength: 2, emoji: '☠️' });
  }

  // 슈팅스타 (Shooting Star) — 상승장 후, 긴 위꼬리
  if (upperShadow(last) >= bodySize(last) * 2 &&
      lowerShadow(last) < bodySize(last) * 0.3 &&
      isBullish(prev)) {
    patterns.push({ name: '슈팅스타', type: 'bearish', strength: 2, emoji: '🌠' });
  }

  // ─── 2봉 패턴 ───

  // 장악형 (Bullish Engulfing) — 하락 후, 양봉이 이전 음봉 전체를 감쌈
  if (isBearish(prev) && isBullish(last) &&
      last.open <= prev.close && last.close >= prev.open &&
      bodySize(last) > bodySize(prev)) {
    patterns.push({ name: '상승장악형', type: 'bullish', strength: 3, emoji: '🟢' });
  }

  // 하락장악형 (Bearish Engulfing)
  if (isBullish(prev) && isBearish(last) &&
      last.open >= prev.close && last.close <= prev.open &&
      bodySize(last) > bodySize(prev)) {
    patterns.push({ name: '하락장악형', type: 'bearish', strength: 3, emoji: '🔴' });
  }

  // 관통형 (Piercing Line) — 하락 후, 양봉이 이전 음봉의 50% 이상 관통
  if (isBearish(prev) && isBullish(last) &&
      last.open < prev.low &&
      last.close > (prev.open + prev.close) / 2 &&
      last.close < prev.open) {
    patterns.push({ name: '관통형', type: 'bullish', strength: 2, emoji: '⚡' });
  }

  // 먹구름 (Dark Cloud Cover) — 상승 후, 음봉이 이전 양봉의 50% 이상 침투
  if (isBullish(prev) && isBearish(last) &&
      last.open > prev.high &&
      last.close < (prev.open + prev.close) / 2 &&
      last.close > prev.open) {
    patterns.push({ name: '먹구름', type: 'bearish', strength: 2, emoji: '🌧️' });
  }

  // ─── 3봉 패턴 ───

  // 샛별형 (Morning Star) — 음봉 → 작은봉(갭다운) → 양봉(갭업)
  if (isBearish(prev2) && bodySize(prev) < avgBody * 0.4 && isBullish(last) &&
      last.close > (prev2.open + prev2.close) / 2) {
    patterns.push({ name: '샛별형', type: 'bullish', strength: 3, emoji: '🌅' });
  }

  // 석별형 (Evening Star)
  if (isBullish(prev2) && bodySize(prev) < avgBody * 0.4 && isBearish(last) &&
      last.close < (prev2.open + prev2.close) / 2) {
    patterns.push({ name: '석별형', type: 'bearish', strength: 3, emoji: '🌆' });
  }

  // 적삼병 (Three White Soldiers)
  if (c.length >= 4) {
    const a = c[c.length - 3], b = c[c.length - 2], d = c[c.length - 1];
    if (isBullish(a) && isBullish(b) && isBullish(d) &&
        b.close > a.close && d.close > b.close &&
        bodySize(a) > avgBody * 0.5 && bodySize(b) > avgBody * 0.5 && bodySize(d) > avgBody * 0.5) {
      patterns.push({ name: '적삼병', type: 'bullish', strength: 3, emoji: '🟩' });
    }
  }

  // 흑삼병 (Three Black Crows)
  if (c.length >= 4) {
    const a = c[c.length - 3], b = c[c.length - 2], d = c[c.length - 1];
    if (isBearish(a) && isBearish(b) && isBearish(d) &&
        b.close < a.close && d.close < b.close &&
        bodySize(a) > avgBody * 0.5 && bodySize(b) > avgBody * 0.5 && bodySize(d) > avgBody * 0.5) {
      patterns.push({ name: '흑삼병', type: 'bearish', strength: 3, emoji: '🟥' });
    }
  }

  return patterns;
}

/**
 * 패턴 점수 합산
 * bullish → +, bearish → -, reversal → 방향은 컨텍스트에 따라
 */
function getPatternScore(patterns, trendContext) {
  let buyScore = 0;
  let sellScore = 0;

  for (const p of patterns) {
    if (p.type === 'bullish') {
      buyScore += p.strength * 0.5;
    } else if (p.type === 'bearish') {
      sellScore += p.strength * 0.5;
    } else if (p.type === 'reversal') {
      // 도지 등: 추세 반대로 약간 가산
      if (trendContext === 'down') buyScore += 0.3;
      else if (trendContext === 'up') sellScore += 0.3;
    }
  }

  return { buyScore, sellScore };
}

module.exports = { detectCandlePatterns, getPatternScore };
