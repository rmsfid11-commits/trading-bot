/**
 * 변동성 돌파 전략 (Larry Williams)
 *
 * 전일 고가-저가 레인지 × K 계수 → 금일 시가에서 돌파 시 매수
 * 한국 암호화폐 시장에서 가장 검증된 전략 중 하나
 *
 * - K = 0.5 (기본) → 레인지의 50% 돌파 시 진입
 * - 당일 종가에 청산 (또는 다음 캔들 시가)
 * - 노이즈 비율 기반 K 자동 조절 가능
 */

/**
 * 일봉 기반 변동성 돌파 시그널 (5분봉 데이터에서 일봉 추출)
 * @param {Array} candles - 5분봉 캔들 데이터
 * @param {Object} opts - { kFactor, adaptiveK }
 * @returns {{ signal, target, range, kUsed, noiseRatio, dayOpen }}
 */
function checkVolatilityBreakout(candles, opts = {}) {
  const { kFactor = 0.5, adaptiveK = true } = opts;

  if (!candles || candles.length < 300) {
    return { signal: 'NONE', reason: '데이터 부족' };
  }

  // 5분봉에서 일봉 데이터 추출 (최근 3일치)
  const dailyBars = extractDailyBars(candles);

  if (dailyBars.length < 2) {
    return { signal: 'NONE', reason: '일봉 데이터 부족' };
  }

  const prevDay = dailyBars[dailyBars.length - 2];
  const today = dailyBars[dailyBars.length - 1];

  // 전일 레인지
  const range = prevDay.high - prevDay.low;
  if (range <= 0) return { signal: 'NONE', reason: '레인지 없음' };

  // K 계수 (노이즈 비율 기반 적응형)
  let kUsed = kFactor;
  let noiseRatio = 0;

  if (adaptiveK && dailyBars.length >= 3) {
    // 노이즈 비율 = 1 - |시가-종가| / (고가-저가)
    // 노이즈가 높으면 K를 높여서 더 큰 돌파만 잡음
    noiseRatio = calcNoiseRatio(dailyBars.slice(-5));
    kUsed = Math.max(0.3, Math.min(0.8, 1 - noiseRatio));
  }

  // 돌파 목표가 = 금일 시가 + 전일 레인지 × K
  const target = today.open + range * kUsed;
  const currentPrice = candles[candles.length - 1].close;
  const dayOpen = today.open;

  // 돌파 여부
  const breakout = currentPrice > target;

  // 추가 필터: 전일 대비 하락 출발이면 더 신중하게
  const gapDown = today.open < prevDay.close * 0.99; // 1% 이상 갭다운

  let signal = 'NONE';
  let score = 0;

  if (breakout && !gapDown) {
    // 돌파 강도 = 현재가가 목표가를 얼마나 넘었는지
    const breakoutPct = ((currentPrice - target) / target) * 100;

    if (breakoutPct >= 0.5) {
      signal = 'STRONG_BUY';
      score = 2.0;
    } else if (breakoutPct >= 0.1) {
      signal = 'BUY';
      score = 1.2;
    } else {
      signal = 'WEAK_BUY';
      score = 0.6;
    }
  } else if (breakout && gapDown) {
    signal = 'WEAK_BUY';
    score = 0.4; // 갭다운 + 돌파 → 조심
  }

  // 하락 돌파 (숏 시그널 / 매도 참고)
  const downTarget = today.open - range * kUsed;
  if (currentPrice < downTarget) {
    signal = 'SELL';
    score = -1.0;
  }

  return {
    signal,
    score,
    target: Math.round(target),
    downTarget: Math.round(downTarget),
    range: Math.round(range),
    kUsed: Math.round(kUsed * 100) / 100,
    noiseRatio: Math.round(noiseRatio * 100) / 100,
    dayOpen: Math.round(dayOpen),
    currentPrice: Math.round(currentPrice),
    breakout,
    prevDayRange: {
      high: Math.round(prevDay.high),
      low: Math.round(prevDay.low),
    },
  };
}

/**
 * 5분봉에서 일봉 데이터 추출
 * KST 기준 00:00 단위로 그룹핑
 */
function extractDailyBars(candles) {
  const dayMap = {};

  for (const c of candles) {
    // KST = UTC+9
    const date = new Date(c.timestamp + 9 * 3600000);
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    if (!dayMap[dayKey]) {
      dayMap[dayKey] = {
        date: dayKey,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      const d = dayMap[dayKey];
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
      d.close = c.close;
      d.volume += c.volume;
    }
  }

  return Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 노이즈 비율 계산 (최근 N일)
 * 높으면 → 횡보/변동 크고 방향 없음, K를 높여야
 * 낮으면 → 추세 명확, K를 낮춰도 됨
 */
function calcNoiseRatio(dailyBars) {
  if (dailyBars.length === 0) return 0.5;

  let totalNoise = 0;
  let count = 0;

  for (const d of dailyBars) {
    const range = d.high - d.low;
    if (range <= 0) continue;
    const body = Math.abs(d.close - d.open);
    const noise = 1 - body / range;
    totalNoise += noise;
    count++;
  }

  return count > 0 ? totalNoise / count : 0.5;
}

module.exports = { checkVolatilityBreakout, extractDailyBars };
