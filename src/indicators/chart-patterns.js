/**
 * 차트 패턴 인식 (Chart Pattern Recognition)
 *
 * 가격 흐름에서 삼각형, 컵앤핸들, 이중바닥, 헤드앤숄더 등 감지
 * candles: 최소 50봉 이상 필요
 */

function detectChartPatterns(candles) {
  if (!candles || candles.length < 50) return [];

  const patterns = [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // 주요 피봇(고점/저점) 찾기
  const pivotHighs = findPivots(highs, 'high', 5);
  const pivotLows = findPivots(lows, 'low', 5);

  // ─── 삼각수렴 (Triangle) ───
  const triangle = detectTriangle(pivotHighs, pivotLows, closes);
  if (triangle) patterns.push(triangle);

  // ─── 이중바닥 (Double Bottom / W패턴) ───
  const doubleBottom = detectDoubleBottom(pivotLows, closes);
  if (doubleBottom) patterns.push(doubleBottom);

  // ─── 이중천장 (Double Top / M패턴) ───
  const doubleTop = detectDoubleTop(pivotHighs, closes);
  if (doubleTop) patterns.push(doubleTop);

  // ─── 컵앤핸들 (Cup and Handle) ───
  const cupHandle = detectCupAndHandle(closes, lows);
  if (cupHandle) patterns.push(cupHandle);

  // ─── 헤드앤숄더 (Head and Shoulders) ───
  const headShoulders = detectHeadAndShoulders(pivotHighs, closes);
  if (headShoulders) patterns.push(headShoulders);

  // ─── 역헤드앤숄더 (Inverse H&S) ───
  const invHS = detectInverseHeadAndShoulders(pivotLows, closes);
  if (invHS) patterns.push(invHS);

  // ─── 웨지 (Wedge) ───
  const wedge = detectWedge(pivotHighs, pivotLows, closes);
  if (wedge) patterns.push(wedge);

  // ─── J커브 (급락 후 강한 반등) ───
  const jCurve = detectJCurve(closes);
  if (jCurve) patterns.push(jCurve);

  return patterns;
}

// ─── 피봇 포인트 찾기 ───

function findPivots(data, type, lookback) {
  const pivots = [];
  for (let i = lookback; i < data.length - lookback; i++) {
    const window = data.slice(i - lookback, i + lookback + 1);
    const val = data[i];
    if (type === 'high' && val === Math.max(...window)) {
      pivots.push({ index: i, value: val });
    }
    if (type === 'low' && val === Math.min(...window)) {
      pivots.push({ index: i, value: val });
    }
  }
  return pivots;
}

// ─── 삼각수렴 ───

function detectTriangle(pivotHighs, pivotLows, closes) {
  if (pivotHighs.length < 2 || pivotLows.length < 2) return null;

  const recentHighs = pivotHighs.slice(-3);
  const recentLows = pivotLows.slice(-3);

  if (recentHighs.length < 2 || recentLows.length < 2) return null;

  const highSlope = (recentHighs[recentHighs.length - 1].value - recentHighs[0].value) /
                    (recentHighs[recentHighs.length - 1].index - recentHighs[0].index || 1);
  const lowSlope = (recentLows[recentLows.length - 1].value - recentLows[0].value) /
                   (recentLows[recentLows.length - 1].index - recentLows[0].index || 1);

  // 두 추세선이 수렴하고 있는지 (범위가 줄어들고 있는지)
  const rangeStart = recentHighs[0].value - recentLows[0].value;
  const rangeEnd = recentHighs[recentHighs.length - 1].value - recentLows[recentLows.length - 1].value;

  if (rangeEnd < rangeStart * 0.7 && rangeStart > 0) {
    let type, signal;
    if (highSlope < 0 && lowSlope > 0) {
      // 대칭 삼각형: 방향 불확실, 브레이크아웃 방향 따라감
      type = '대칭삼각형';
      signal = closes[closes.length - 1] > recentHighs[recentHighs.length - 1].value ? 'bullish' : 'neutral';
    } else if (highSlope < 0 && lowSlope >= 0) {
      // 하향 삼각형: 저점 유지 + 고점 하락 → 보통 하방
      type = '하향삼각형';
      signal = 'bearish';
    } else if (highSlope >= 0 && lowSlope > 0) {
      // 상향 삼각형: 고점 유지 + 저점 상승 → 보통 상방
      type = '상향삼각형';
      signal = 'bullish';
    } else {
      return null;
    }

    return {
      name: type,
      type: signal,
      strength: 2,
      emoji: '📐',
      detail: `범위 ${((1 - rangeEnd / rangeStart) * 100).toFixed(0)}% 수렴`,
    };
  }

  return null;
}

// ─── 이중바닥 (W패턴) ───

function detectDoubleBottom(pivotLows, closes) {
  if (pivotLows.length < 2) return null;

  const recent = pivotLows.slice(-4);
  for (let i = 0; i < recent.length - 1; i++) {
    const first = recent[i];
    const second = recent[i + 1];
    const dist = second.index - first.index;

    if (dist < 10 || dist > 100) continue;

    // 두 저점이 비슷한 수준 (±2%)
    const diff = Math.abs(first.value - second.value) / first.value;
    if (diff < 0.02) {
      // 현재 가격이 중간 고점 위에 있으면 확인
      const midHighs = closes.slice(first.index, second.index);
      const neckline = Math.max(...midHighs);
      const currentPrice = closes[closes.length - 1];

      if (currentPrice > neckline * 0.98) {
        return {
          name: '이중바닥(W)',
          type: 'bullish',
          strength: 3,
          emoji: '〰️',
          detail: `넥라인 ${Math.round(neckline).toLocaleString()} 돌파`,
        };
      }
    }
  }
  return null;
}

// ─── 이중천장 (M패턴) ───

function detectDoubleTop(pivotHighs, closes) {
  if (pivotHighs.length < 2) return null;

  const recent = pivotHighs.slice(-4);
  for (let i = 0; i < recent.length - 1; i++) {
    const first = recent[i];
    const second = recent[i + 1];
    const dist = second.index - first.index;

    if (dist < 10 || dist > 100) continue;

    const diff = Math.abs(first.value - second.value) / first.value;
    if (diff < 0.02) {
      const midLows = closes.slice(first.index, second.index);
      const neckline = Math.min(...midLows);
      const currentPrice = closes[closes.length - 1];

      if (currentPrice < neckline * 1.02) {
        return {
          name: '이중천장(M)',
          type: 'bearish',
          strength: 3,
          emoji: '🏔️',
          detail: `넥라인 ${Math.round(neckline).toLocaleString()} 이탈`,
        };
      }
    }
  }
  return null;
}

// ─── 컵앤핸들 ───

function detectCupAndHandle(closes, lows) {
  const n = closes.length;
  if (n < 40) return null;

  // 컵: 최근 30~50봉에서 U자형 찾기
  const cupRange = closes.slice(-50);
  const cupMin = Math.min(...cupRange);
  const cupMinIdx = cupRange.indexOf(cupMin);
  const cupStart = cupRange[0];
  const cupEnd = cupRange[cupRange.length - 1];

  // U자형 조건: 시작/끝이 높고, 중간이 낮음
  const lipLevel = Math.min(cupStart, cupEnd);
  const depth = (lipLevel - cupMin) / lipLevel;

  if (depth > 0.03 && depth < 0.20 && // 3~20% 깊이
      cupMinIdx > 10 && cupMinIdx < 40 && // 중간에 바닥
      cupEnd > lipLevel * 0.97) { // 현재가 립 수준 복귀

    // 핸들: 마지막 10봉에서 약간의 하락 (2~5%)
    const handle = closes.slice(-10);
    const handleDip = (Math.max(...handle) - Math.min(...handle)) / Math.max(...handle);

    if (handleDip > 0.01 && handleDip < 0.08 &&
        closes[n - 1] > Math.min(...handle)) {
      return {
        name: '컵앤핸들',
        type: 'bullish',
        strength: 3,
        emoji: '☕',
        detail: `깊이 ${(depth * 100).toFixed(1)}%, 핸들 ${(handleDip * 100).toFixed(1)}%`,
      };
    }
  }
  return null;
}

// ─── 헤드앤숄더 ───

function detectHeadAndShoulders(pivotHighs, closes) {
  if (pivotHighs.length < 3) return null;

  const recent = pivotHighs.slice(-5);
  for (let i = 0; i < recent.length - 2; i++) {
    const left = recent[i];
    const head = recent[i + 1];
    const right = recent[i + 2];

    // 헤드가 양쪽 숄더보다 높아야 함
    if (head.value <= left.value || head.value <= right.value) continue;

    // 양쪽 숄더가 비슷한 높이 (±5%)
    const shoulderDiff = Math.abs(left.value - right.value) / left.value;
    if (shoulderDiff > 0.05) continue;

    // 넥라인 돌파 확인
    const neckline = Math.min(
      closes[Math.min(left.index + 3, closes.length - 1)],
      closes[Math.min(head.index + 3, closes.length - 1)]
    );
    const currentPrice = closes[closes.length - 1];

    if (currentPrice < neckline) {
      return {
        name: '헤드앤숄더',
        type: 'bearish',
        strength: 3,
        emoji: '👤',
        detail: `헤드 ${Math.round(head.value).toLocaleString()}`,
      };
    }
  }
  return null;
}

// ─── 역 헤드앤숄더 ───

function detectInverseHeadAndShoulders(pivotLows, closes) {
  if (pivotLows.length < 3) return null;

  const recent = pivotLows.slice(-5);
  for (let i = 0; i < recent.length - 2; i++) {
    const left = recent[i];
    const head = recent[i + 1];
    const right = recent[i + 2];

    if (head.value >= left.value || head.value >= right.value) continue;

    const shoulderDiff = Math.abs(left.value - right.value) / left.value;
    if (shoulderDiff > 0.05) continue;

    const neckline = Math.max(
      closes[Math.min(left.index + 3, closes.length - 1)],
      closes[Math.min(head.index + 3, closes.length - 1)]
    );
    const currentPrice = closes[closes.length - 1];

    if (currentPrice > neckline) {
      return {
        name: '역헤드앤숄더',
        type: 'bullish',
        strength: 3,
        emoji: '🙃',
        detail: `넥라인 ${Math.round(neckline).toLocaleString()} 돌파`,
      };
    }
  }
  return null;
}

// ─── 웨지 (Wedge) ───

function detectWedge(pivotHighs, pivotLows, closes) {
  if (pivotHighs.length < 2 || pivotLows.length < 2) return null;

  const rh = pivotHighs.slice(-3);
  const rl = pivotLows.slice(-3);

  if (rh.length < 2 || rl.length < 2) return null;

  const highSlope = (rh[rh.length - 1].value - rh[0].value) / (rh[rh.length - 1].index - rh[0].index || 1);
  const lowSlope = (rl[rl.length - 1].value - rl[0].value) / (rl[rl.length - 1].index - rl[0].index || 1);

  // 상승 웨지: 둘 다 상승하지만 저점이 더 빠르게 → 베어리시
  if (highSlope > 0 && lowSlope > 0 && lowSlope > highSlope * 0.5) {
    const converging = (rh[rh.length - 1].value - rl[rl.length - 1].value) <
                       (rh[0].value - rl[0].value);
    if (converging) {
      return {
        name: '상승쐐기',
        type: 'bearish',
        strength: 2,
        emoji: '📈⚠️',
        detail: '수렴 상승 → 하방 가능성',
      };
    }
  }

  // 하강 웨지: 둘 다 하락하지만 고점이 더 빠르게 → 불리시
  if (highSlope < 0 && lowSlope < 0 && highSlope < lowSlope * 0.5) {
    const converging = (rh[rh.length - 1].value - rl[rl.length - 1].value) <
                       (rh[0].value - rl[0].value);
    if (converging) {
      return {
        name: '하강쐐기',
        type: 'bullish',
        strength: 2,
        emoji: '📉✅',
        detail: '수렴 하락 → 상방 가능성',
      };
    }
  }

  return null;
}

// ─── J커브 (급락 후 강한 반등) ───

function detectJCurve(closes) {
  const n = closes.length;
  if (n < 20) return null;

  const recent = closes.slice(-20);
  const minIdx = recent.indexOf(Math.min(...recent));

  // 바닥이 10~17봉 전 사이에 있어야 함
  if (minIdx < 3 || minIdx > 17) return null;

  const beforeDip = recent.slice(0, minIdx);
  const afterDip = recent.slice(minIdx);

  if (beforeDip.length < 3 || afterDip.length < 3) return null;

  const preLevel = beforeDip[0];
  const bottom = recent[minIdx];
  const current = recent[recent.length - 1];

  const dropPct = (preLevel - bottom) / preLevel;
  const recoveryPct = (current - bottom) / bottom;

  // J커브 조건: 5% 이상 하락 후, 바닥 대비 7% 이상 반등, 현재 시작점 넘어섬
  if (dropPct > 0.05 && recoveryPct > 0.07 && current > preLevel) {
    return {
      name: 'J커브',
      type: 'bullish',
      strength: 2,
      emoji: '📈',
      detail: `하락 ${(dropPct * 100).toFixed(1)}% → 반등 ${(recoveryPct * 100).toFixed(1)}%`,
    };
  }

  // 약한 J커브: 시작점 못 넘었지만 강한 반등 중
  if (dropPct > 0.03 && recoveryPct > 0.05 && current > bottom * 1.05) {
    return {
      name: 'J커브(진행중)',
      type: 'bullish',
      strength: 1,
      emoji: '↗️',
      detail: `반등 ${(recoveryPct * 100).toFixed(1)}% 진행 중`,
    };
  }

  return null;
}

/**
 * 차트 패턴 점수 합산
 */
function getChartPatternScore(patterns) {
  let buyScore = 0;
  let sellScore = 0;

  for (const p of patterns) {
    if (p.type === 'bullish') {
      buyScore += p.strength * 0.7;
    } else if (p.type === 'bearish') {
      sellScore += p.strength * 0.7;
    }
  }

  return { buyScore, sellScore };
}

module.exports = { detectChartPatterns, getChartPatternScore };
