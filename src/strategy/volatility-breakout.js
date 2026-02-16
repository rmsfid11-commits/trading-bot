/**
 * 변동성 돌파 전략 (Larry Williams Volatility Breakout)
 *
 * 전일 고가-저가 = range
 * 오늘 시가 + (range * K) = breakout price → 현재가 초과 시 BUY
 * 오늘 시가 - (range * K) = breakdown price → 현재가 하회 시 SELL
 *
 * K factor: 기본 0.5, 설정 가능
 * 거래량 확인: 현재 거래량 > 평균 거래량이어야 유효한 시그널
 */

/**
 * 변동성 돌파 시그널 계산
 * @param {Array} candles - 5분봉 캔들 데이터 (최소 300개 권장)
 * @param {number} k - K factor (기본 0.5)
 * @returns {{ signal: 'buy'|'sell'|'none', breakoutPrice: number, breakdownPrice: number, range: number, strength: number, reason: string }}
 */
function calculateBreakoutSignal(candles, k = 0.5) {
  if (!candles || candles.length < 100) {
    return { signal: 'none', breakoutPrice: 0, breakdownPrice: 0, range: 0, strength: 0, reason: '데이터 부족' };
  }

  // 5분봉에서 일봉 데이터 추출
  const dailyBars = extractDailyBarsForBreakout(candles);

  if (dailyBars.length < 2) {
    return { signal: 'none', breakoutPrice: 0, breakdownPrice: 0, range: 0, strength: 0, reason: '일봉 데이터 부족' };
  }

  const prevDay = dailyBars[dailyBars.length - 2];
  const today = dailyBars[dailyBars.length - 1];

  // 전일 고가-저가 = range
  const range = prevDay.high - prevDay.low;
  if (range <= 0) {
    return { signal: 'none', breakoutPrice: 0, breakdownPrice: 0, range: 0, strength: 0, reason: '전일 레인지 없음' };
  }

  // 돌파 목표가 / 하락 목표가
  const breakoutPrice = today.open + (range * k);
  const breakdownPrice = today.open - (range * k);
  const currentPrice = candles[candles.length - 1].close;

  // 거래량 확인: 최근 5봉 평균 vs 전체 평균
  const volumes = candles.map(c => c.volume);
  const avgVolume = volumes.slice(-60).reduce((s, v) => s + v, 0) / Math.min(60, volumes.length); // 최근 60봉(5시간) 평균
  const recentVolume = volumes.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, volumes.length);   // 최근 5봉(25분) 평균
  const volumeConfirmed = recentVolume > avgVolume; // 현재 거래량 > 평균

  // 시그널 판단
  let signal = 'none';
  let strength = 0;
  let reason = '';

  if (currentPrice > breakoutPrice) {
    // 상방 돌파
    const breakoutPct = ((currentPrice - breakoutPrice) / breakoutPrice) * 100;

    if (volumeConfirmed) {
      // 거래량 확인됨 → 유효한 돌파
      if (breakoutPct >= 0.5) {
        signal = 'buy';
        strength = 1.5;
        reason = `변동성 돌파 (K=${k}, 목표가 ${Math.round(breakoutPrice).toLocaleString()}, +${breakoutPct.toFixed(2)}%, 거래량 확인)`;
      } else if (breakoutPct >= 0.1) {
        signal = 'buy';
        strength = 1.0;
        reason = `변동성 돌파 (K=${k}, 목표가 ${Math.round(breakoutPrice).toLocaleString()}, +${breakoutPct.toFixed(2)}%, 거래량 확인)`;
      } else {
        signal = 'buy';
        strength = 0.5;
        reason = `변동성 돌파 약 (K=${k}, 목표가 ${Math.round(breakoutPrice).toLocaleString()}, +${breakoutPct.toFixed(2)}%)`;
      }
    } else {
      // 거래량 미확인 → 약한 시그널
      signal = 'buy';
      strength = 0.3;
      reason = `변동성 돌파 (K=${k}, 목표가 ${Math.round(breakoutPrice).toLocaleString()}, 거래량 미확인)`;
    }
  } else if (currentPrice < breakdownPrice) {
    // 하방 돌파 (breakdown)
    const breakdownPct = ((breakdownPrice - currentPrice) / breakdownPrice) * 100;

    if (volumeConfirmed) {
      if (breakdownPct >= 0.5) {
        signal = 'sell';
        strength = 1.5;
        reason = `변동성 하락돌파 (K=${k}, 목표가 ${Math.round(breakdownPrice).toLocaleString()}, -${breakdownPct.toFixed(2)}%, 거래량 확인)`;
      } else {
        signal = 'sell';
        strength = 1.0;
        reason = `변동성 하락돌파 (K=${k}, 목표가 ${Math.round(breakdownPrice).toLocaleString()}, -${breakdownPct.toFixed(2)}%)`;
      }
    } else {
      signal = 'sell';
      strength = 0.5;
      reason = `변동성 하락돌파 (K=${k}, 목표가 ${Math.round(breakdownPrice).toLocaleString()}, 거래량 미확인)`;
    }
  } else {
    reason = '돌파 없음';
  }

  return {
    signal,
    breakoutPrice: Math.round(breakoutPrice),
    breakdownPrice: Math.round(breakdownPrice),
    range: Math.round(range),
    strength,
    reason,
    currentPrice: Math.round(currentPrice),
    dayOpen: Math.round(today.open),
    k,
    volumeConfirmed,
    volumeRatio: avgVolume > 0 ? Math.round((recentVolume / avgVolume) * 100) / 100 : 0,
  };
}

/**
 * 5분봉에서 일봉 데이터 추출 (KST 기준)
 */
function extractDailyBarsForBreakout(candles) {
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

module.exports = { calculateBreakoutSignal };
