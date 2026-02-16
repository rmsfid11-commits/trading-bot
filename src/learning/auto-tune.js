const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');
const AUTO_TUNE_FILE = 'auto-tune-results.json';
const TUNE_INTERVAL_DAYS = 7; // 7일마다 자동 튜닝
const MIN_TRADES_FOR_TUNE = 20; // 최소 20건의 거래 필요
const MIN_CONFIDENCE = 0.6; // 최소 신뢰도
const MIN_SAMPLE_SIZE = 10; // 버킷당 최소 샘플 수
const MAX_CHANGE_PCT = 0.20; // 튜닝 사이클당 최대 ±20% 변경

// ─── 튜닝 대상 파라미터 정의 ───

const TUNE_PARAMS = {
  RSI_OVERSOLD: {
    min: 20, max: 40, step: 2,
    snapshotKey: 'rsi',  // 스냅샷에서 진입 시 RSI 값
    description: 'RSI 과매도 기준',
    // 매수 시 RSI가 이 값 이하일 때 진입 → 낮을수록 보수적
    bucketFn: (value) => Math.floor(value / 5) * 5, // 5단위 버킷
  },
  RSI_OVERBOUGHT: {
    min: 60, max: 85, step: 2,
    snapshotKey: 'rsi',
    description: 'RSI 과매수 기준',
    bucketFn: (value) => Math.floor(value / 5) * 5,
  },
  STOP_LOSS_PCT: {
    min: -5, max: -1, step: 0.5,
    snapshotKey: null, // 손익률 기반 분석
    description: '손절 기준(%)',
    bucketFn: (value) => Math.round(value),
  },
  TAKE_PROFIT_PCT: {
    min: 2, max: 10, step: 0.5,
    snapshotKey: null, // 손익률 기반 분석
    description: '익절 기준(%)',
    bucketFn: (value) => Math.round(value),
  },
  TRAILING_DISTANCE_PCT: {
    min: 0.5, max: 3.0, step: 0.25,
    snapshotKey: null,
    description: '트레일링 스탑 거리(%)',
    bucketFn: (value) => Math.round(value * 2) / 2, // 0.5 단위
  },
  MAX_HOLD_HOURS: {
    min: 2, max: 24, step: 1,
    snapshotKey: null, // holdHours 기반 분석
    description: '최대 보유 시간',
    bucketFn: (value) => Math.floor(value / 2) * 2, // 2시간 단위
  },
  BOLLINGER_STD_DEV: {
    min: 1.5, max: 3.0, step: 0.25,
    snapshotKey: 'bbPosition',
    description: '볼린저 밴드 표준편차',
    bucketFn: (value) => Math.round(value * 4) / 4, // 0.25 단위
  },
  VOLUME_THRESHOLD: {
    min: 1.0, max: 3.0, step: 0.25,
    snapshotKey: 'volumeRatio',
    description: '거래량 배수 기준',
    bucketFn: (value) => Math.round(value * 2) / 2, // 0.5 단위
  },
};

// ─── trades.jsonl 로드 & 페어 매칭 ───

function loadTrades(logDir) {
  const tradesPath = path.join(logDir, 'trades.jsonl');
  if (!fs.existsSync(tradesPath)) return [];
  const lines = fs.readFileSync(tradesPath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function matchTradePairs(trades) {
  const openBuys = {}; // symbol → [buy, buy, ...]
  const pairs = [];

  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!openBuys[t.symbol]) openBuys[t.symbol] = [];
      openBuys[t.symbol].push(t);
    } else if ((t.action === 'SELL' || t.action === 'PARTIAL_SELL') && openBuys[t.symbol]?.length) {
      const buy = t.action === 'SELL' ? openBuys[t.symbol].shift() : openBuys[t.symbol][0];
      const pnlPct = t.pnl != null
        ? t.pnl
        : ((t.price - buy.price) / buy.price) * 100;
      const holdMs = t.timestamp - buy.timestamp;
      pairs.push({
        symbol: t.symbol,
        buyTime: buy.timestamp,
        sellTime: t.timestamp,
        buyPrice: buy.price,
        sellPrice: t.price,
        pnlPct,
        holdMs,
        holdHours: holdMs / 3600000,
        buyReason: buy.reason || '',
        sellReason: t.reason || '',
        amount: buy.amount || t.amount || 0,
        win: pnlPct > 0,
        // 스냅샷 데이터 (진입 시 지표 값)
        snapshot: buy.snapshot || {},
      });
    }
  }
  return pairs;
}

// ─── 파라미터별 최적값 찾기 ───

/**
 * 특정 파라미터에 대해 버킷 분석 수행
 * @param {Array} pairs - 매칭된 거래 쌍
 * @param {string} paramName - 파라미터 이름
 * @param {object} paramConfig - 파라미터 설정
 * @param {number} currentValue - 현재 파라미터 값
 * @returns {object} 분석 결과
 */
function analyzeParameter(pairs, paramName, paramConfig, currentValue) {
  const result = {
    param: paramName,
    currentValue,
    suggestedValue: currentValue,
    confidence: 0,
    sampleSize: 0,
    reasoning: '',
    buckets: {},
  };

  // 파라미터 유형에 따라 다른 분석 로직
  switch (paramName) {
    case 'RSI_OVERSOLD':
      return analyzeRsiOversold(pairs, currentValue, paramConfig);
    case 'RSI_OVERBOUGHT':
      return analyzeRsiOverbought(pairs, currentValue, paramConfig);
    case 'STOP_LOSS_PCT':
      return analyzeStopLoss(pairs, currentValue, paramConfig);
    case 'TAKE_PROFIT_PCT':
      return analyzeTakeProfit(pairs, currentValue, paramConfig);
    case 'TRAILING_DISTANCE_PCT':
      return analyzeTrailingDistance(pairs, currentValue, paramConfig);
    case 'MAX_HOLD_HOURS':
      return analyzeMaxHoldHours(pairs, currentValue, paramConfig);
    case 'BOLLINGER_STD_DEV':
      return analyzeBollingerStdDev(pairs, currentValue, paramConfig);
    case 'VOLUME_THRESHOLD':
      return analyzeVolumeThreshold(pairs, currentValue, paramConfig);
    default:
      return result;
  }
}

// ─── RSI 과매도 분석: 진입 시 RSI가 낮을수록 승률 높은지 확인 ───

function analyzeRsiOversold(pairs, currentValue, config) {
  const buckets = {};

  for (const p of pairs) {
    const rsi = p.snapshot?.rsi;
    if (rsi == null || rsi > 50) continue; // RSI 50 이하만 관심

    const bucketKey = config.bucketFn(rsi);
    if (!buckets[bucketKey]) buckets[bucketKey] = { trades: 0, wins: 0, totalPnl: 0, rsiValues: [] };
    buckets[bucketKey].trades++;
    if (p.win) buckets[bucketKey].wins++;
    buckets[bucketKey].totalPnl += p.pnlPct;
    buckets[bucketKey].rsiValues.push(rsi);
  }

  return findOptimalFromBuckets(buckets, 'RSI_OVERSOLD', currentValue, config, '과매도 RSI');
}

// ─── RSI 과매수 분석: 매도 타이밍의 RSI 분석 ───

function analyzeRsiOverbought(pairs, currentValue, config) {
  const buckets = {};

  for (const p of pairs) {
    const rsi = p.snapshot?.rsi;
    if (rsi == null || rsi < 50) continue; // RSI 50 이상만 관심

    const bucketKey = config.bucketFn(rsi);
    if (!buckets[bucketKey]) buckets[bucketKey] = { trades: 0, wins: 0, totalPnl: 0 };
    buckets[bucketKey].trades++;
    if (p.win) buckets[bucketKey].wins++;
    buckets[bucketKey].totalPnl += p.pnlPct;
  }

  return findOptimalFromBuckets(buckets, 'RSI_OVERBOUGHT', currentValue, config, '과매수 RSI');
}

// ─── 손절 분석: 각 손절 레벨에서의 시뮬레이션 ───

function analyzeStopLoss(pairs, currentValue, config) {
  const results = {};

  // 다양한 손절 레벨에서 시뮬레이션
  for (let sl = config.min; sl <= config.max; sl += config.step) {
    const slRound = Math.round(sl * 100) / 100;
    let wins = 0;
    let totalPnl = 0;
    let trades = 0;
    let stoppedOut = 0;

    for (const p of pairs) {
      trades++;
      let adjustedPnl = p.pnlPct;

      // 손절선보다 더 떨어졌으면 → 이 손절선에서 잘렸을 것
      if (p.pnlPct < slRound) {
        adjustedPnl = slRound;
        stoppedOut++;
      }

      totalPnl += adjustedPnl;
      if (adjustedPnl > 0) wins++;
    }

    if (trades === 0) continue;
    const winRate = wins / trades;
    const avgPnl = totalPnl / trades;
    // 리스크 조정 수익 = 승률 × 평균손익
    const riskAdjustedReturn = winRate * avgPnl;

    results[slRound] = {
      trades,
      wins,
      winRate: Math.round(winRate * 100),
      avgPnl: Math.round(avgPnl * 100) / 100,
      riskAdjustedReturn: Math.round(riskAdjustedReturn * 100) / 100,
      stoppedOut,
    };
  }

  return findOptimalFromSimulation(results, 'STOP_LOSS_PCT', currentValue, config, '손절');
}

// ─── 익절 분석: 각 익절 레벨에서의 시뮬레이션 ───

function analyzeTakeProfit(pairs, currentValue, config) {
  const results = {};

  for (let tp = config.min; tp <= config.max; tp += config.step) {
    const tpRound = Math.round(tp * 100) / 100;
    let wins = 0;
    let totalPnl = 0;
    let trades = 0;

    for (const p of pairs) {
      trades++;
      let adjustedPnl = p.pnlPct;

      // 익절선보다 더 올랐으면 → 이 익절선에서 나왔을 것
      if (p.pnlPct > tpRound) {
        adjustedPnl = tpRound;
      }

      totalPnl += adjustedPnl;
      if (adjustedPnl > 0) wins++;
    }

    if (trades === 0) continue;
    const winRate = wins / trades;
    const avgPnl = totalPnl / trades;
    const riskAdjustedReturn = winRate * avgPnl;

    results[tpRound] = {
      trades,
      wins,
      winRate: Math.round(winRate * 100),
      avgPnl: Math.round(avgPnl * 100) / 100,
      riskAdjustedReturn: Math.round(riskAdjustedReturn * 100) / 100,
    };
  }

  return findOptimalFromSimulation(results, 'TAKE_PROFIT_PCT', currentValue, config, '익절');
}

// ─── 트레일링 스탑 분석 ───

function analyzeTrailingDistance(pairs, currentValue, config) {
  const results = {};

  // 수익 거래만 대상으로 트레일링 거리 분석
  const winningPairs = pairs.filter(p => p.win);
  if (winningPairs.length < 5) {
    return {
      param: 'TRAILING_DISTANCE_PCT',
      currentValue,
      suggestedValue: currentValue,
      confidence: 0,
      sampleSize: winningPairs.length,
      reasoning: `수익 거래 부족 (${winningPairs.length}/5)`,
      buckets: {},
    };
  }

  for (let td = config.min; td <= config.max; td += config.step) {
    const tdRound = Math.round(td * 100) / 100;
    let totalPnl = 0;
    let trades = 0;

    for (const p of winningPairs) {
      trades++;
      // 트레일링 거리가 좁으면: 조기 청산 → 수익 감소
      // 트레일링 거리가 넓으면: 수익 더 먹을 수 있지만 반락 위험
      // 시뮬레이션: 수익이 트레일링 거리보다 작으면 수익의 일부만 실현
      const adjustedPnl = Math.min(p.pnlPct, Math.max(p.pnlPct - tdRound, p.pnlPct * 0.5));
      totalPnl += adjustedPnl;
    }

    if (trades === 0) continue;
    const avgPnl = totalPnl / trades;

    results[tdRound] = {
      trades,
      wins: trades, // 전부 수익 거래
      winRate: 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
      riskAdjustedReturn: Math.round(avgPnl * 100) / 100,
    };
  }

  return findOptimalFromSimulation(results, 'TRAILING_DISTANCE_PCT', currentValue, config, '트레일링 거리');
}

// ─── 보유 시간 분석 ───

function analyzeMaxHoldHours(pairs, currentValue, config) {
  const buckets = {};

  for (const p of pairs) {
    const holdBucket = config.bucketFn(p.holdHours);
    if (!buckets[holdBucket]) buckets[holdBucket] = { trades: 0, wins: 0, totalPnl: 0 };
    buckets[holdBucket].trades++;
    if (p.win) buckets[holdBucket].wins++;
    buckets[holdBucket].totalPnl += p.pnlPct;
  }

  // 보유 시간별 누적 분석: X시간까지 보유한 거래의 승률/수익
  const cumResults = {};
  for (let h = config.min; h <= config.max; h += config.step) {
    let trades = 0;
    let wins = 0;
    let totalPnl = 0;

    for (const p of pairs) {
      if (p.holdHours <= h) {
        trades++;
        if (p.win) wins++;
        totalPnl += p.pnlPct;
      } else {
        // 보유시간 초과: 중간 손익으로 추정
        trades++;
        const adjustedPnl = p.pnlPct * (h / p.holdHours);
        totalPnl += adjustedPnl;
        if (adjustedPnl > 0) wins++;
      }
    }

    if (trades === 0) continue;
    const winRate = wins / trades;
    const avgPnl = totalPnl / trades;

    cumResults[h] = {
      trades,
      wins,
      winRate: Math.round(winRate * 100),
      avgPnl: Math.round(avgPnl * 100) / 100,
      riskAdjustedReturn: Math.round(winRate * avgPnl * 100) / 100,
    };
  }

  return findOptimalFromSimulation(cumResults, 'MAX_HOLD_HOURS', currentValue, config, '최대 보유시간');
}

// ─── 볼린저 밴드 분석: BB 포지션별 승률 ───

function analyzeBollingerStdDev(pairs, currentValue, config) {
  const buckets = {};

  for (const p of pairs) {
    const bbPos = p.snapshot?.bbPosition;
    if (bbPos == null) continue;

    // bbPosition이 0에 가까울수록 하단밴드, 1에 가까울수록 상단밴드
    const bucketKey = config.bucketFn(bbPos);
    if (!buckets[bucketKey]) buckets[bucketKey] = { trades: 0, wins: 0, totalPnl: 0 };
    buckets[bucketKey].trades++;
    if (p.win) buckets[bucketKey].wins++;
    buckets[bucketKey].totalPnl += p.pnlPct;
  }

  // BB 표준편차 직접 시뮬레이션은 어렵 → 진입 BB 위치로 간접 분석
  // bbPosition < 0.2이면 하단밴드 근처 진입 → 좋은 진입
  // 승률이 높은 BB 포지션 범위를 기반으로 stdDev 조정
  const totalWithSnapshot = pairs.filter(p => p.snapshot?.bbPosition != null).length;
  const lowBBPairs = pairs.filter(p => p.snapshot?.bbPosition != null && p.snapshot.bbPosition < 0.3);
  const lowBBWins = lowBBPairs.filter(p => p.win).length;
  const lowBBWinRate = lowBBPairs.length > 0 ? lowBBWins / lowBBPairs.length : 0;

  const highBBPairs = pairs.filter(p => p.snapshot?.bbPosition != null && p.snapshot.bbPosition > 0.3);
  const highBBWins = highBBPairs.filter(p => p.win).length;
  const highBBWinRate = highBBPairs.length > 0 ? highBBWins / highBBPairs.length : 0;

  let suggestedValue = currentValue;
  let reasoning = '';

  if (lowBBPairs.length >= 5 && highBBPairs.length >= 5) {
    if (lowBBWinRate > highBBWinRate + 0.1) {
      // 하단밴드 진입이 더 좋다 → stdDev 줄이면 밴드가 좁아져서 진입 기회 증가
      suggestedValue = Math.max(config.min, currentValue - 0.25);
      reasoning = `하단밴드 진입 승률(${Math.round(lowBBWinRate * 100)}%) > 상단(${Math.round(highBBWinRate * 100)}%) → 밴드 좁히기`;
    } else if (highBBWinRate > lowBBWinRate + 0.1) {
      // 상단 진입이 더 좋다 → stdDev 늘리면 밴드 넓어져서 진입 엄격
      suggestedValue = Math.min(config.max, currentValue + 0.25);
      reasoning = `상단밴드 진입 승률(${Math.round(highBBWinRate * 100)}%) > 하단(${Math.round(lowBBWinRate * 100)}%) → 밴드 넓히기`;
    } else {
      reasoning = `하단(${Math.round(lowBBWinRate * 100)}%)≈상단(${Math.round(highBBWinRate * 100)}%) → 변경 불필요`;
    }
  } else {
    reasoning = `스냅샷 데이터 부족 (하단 ${lowBBPairs.length}건, 상단 ${highBBPairs.length}건)`;
  }

  const sampleSize = totalWithSnapshot;
  const confidence = calcParamConfidence(sampleSize, suggestedValue, currentValue);

  return {
    param: 'BOLLINGER_STD_DEV',
    currentValue,
    suggestedValue: Math.round(suggestedValue * 100) / 100,
    confidence,
    sampleSize,
    reasoning,
    buckets,
  };
}

// ─── 거래량 임계값 분석 ───

function analyzeVolumeThreshold(pairs, currentValue, config) {
  const buckets = {};

  for (const p of pairs) {
    const volRatio = p.snapshot?.volumeRatio;
    if (volRatio == null) continue;

    const bucketKey = config.bucketFn(volRatio);
    if (!buckets[bucketKey]) buckets[bucketKey] = { trades: 0, wins: 0, totalPnl: 0 };
    buckets[bucketKey].trades++;
    if (p.win) buckets[bucketKey].wins++;
    buckets[bucketKey].totalPnl += p.pnlPct;
  }

  return findOptimalFromBuckets(buckets, 'VOLUME_THRESHOLD', currentValue, config, '거래량 배수');
}

// ─── 공통: 버킷에서 최적값 찾기 ───

function findOptimalFromBuckets(buckets, paramName, currentValue, config, label) {
  let bestKey = null;
  let bestScore = -Infinity;
  let totalSamples = 0;

  for (const [key, bucket] of Object.entries(buckets)) {
    totalSamples += bucket.trades;
    if (bucket.trades < 3) continue; // 최소 3건

    const winRate = bucket.wins / bucket.trades;
    const avgPnl = bucket.totalPnl / bucket.trades;
    const riskAdjScore = winRate * avgPnl;

    bucket.winRate = Math.round(winRate * 100);
    bucket.avgPnl = Math.round(avgPnl * 100) / 100;
    bucket.riskAdjScore = Math.round(riskAdjScore * 100) / 100;

    if (riskAdjScore > bestScore) {
      bestScore = riskAdjScore;
      bestKey = Number(key);
    }
  }

  const suggestedValue = bestKey != null ? bestKey : currentValue;
  const confidence = calcParamConfidence(totalSamples, suggestedValue, currentValue);
  const bestBucket = bestKey != null ? buckets[bestKey] : null;
  const reasoning = bestBucket
    ? `${label} ${bestKey} 버킷: 승률 ${bestBucket.winRate}%, 평균손익 ${bestBucket.avgPnl}% (${bestBucket.trades}건)`
    : `${label} 분석 데이터 부족`;

  return {
    param: paramName,
    currentValue,
    suggestedValue: Math.round(suggestedValue * 100) / 100,
    confidence,
    sampleSize: totalSamples,
    reasoning,
    buckets,
  };
}

// ─── 공통: 시뮬레이션 결과에서 최적값 찾기 ───

function findOptimalFromSimulation(results, paramName, currentValue, config, label) {
  let bestKey = null;
  let bestScore = -Infinity;
  let totalSamples = 0;

  for (const [key, res] of Object.entries(results)) {
    if (res.trades > totalSamples) totalSamples = res.trades;

    if (res.riskAdjustedReturn > bestScore) {
      bestScore = res.riskAdjustedReturn;
      bestKey = Number(key);
    }
  }

  const suggestedValue = bestKey != null ? bestKey : currentValue;
  const confidence = calcParamConfidence(totalSamples, suggestedValue, currentValue);
  const bestResult = bestKey != null ? results[bestKey] : null;
  const reasoning = bestResult
    ? `${label} ${bestKey}: 승률 ${bestResult.winRate}%, 평균손익 ${bestResult.avgPnl}% (${bestResult.trades}건)`
    : `${label} 시뮬레이션 데이터 부족`;

  return {
    param: paramName,
    currentValue,
    suggestedValue: Math.round(suggestedValue * 100) / 100,
    confidence,
    sampleSize: totalSamples,
    reasoning,
    buckets: results,
  };
}

// ─── 파라미터별 신뢰도 계산 ───

function calcParamConfidence(sampleSize, suggestedValue, currentValue) {
  // 1. 데이터 양 기반 (10건→0.3, 20건→0.5, 50건→0.8, 100+건→1.0)
  const dataScore = Math.min(1, sampleSize / 100);

  // 2. 변경 폭 기반: 작은 변경일수록 신뢰도 높음
  const absDefault = Math.abs(currentValue) || 1;
  const changePct = Math.abs(suggestedValue - currentValue) / absDefault;
  const stabilityScore = 1 - Math.min(1, changePct * 2);

  // 가중 평균
  const confidence = dataScore * 0.6 + stabilityScore * 0.4;
  return Math.round(confidence * 100) / 100;
}

// ─── 안전 제약: 최대 변경폭 제한 ───

function clampChange(currentValue, suggestedValue, maxChangePct) {
  if (currentValue === 0) return suggestedValue;

  const absCurrent = Math.abs(currentValue);
  const maxDelta = absCurrent * maxChangePct;
  const delta = suggestedValue - currentValue;
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta));

  return Math.round((currentValue + clampedDelta) * 100) / 100;
}

// ─── 메인: autoTune 함수 ───

function autoTune(logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;

  // 1. 거래 데이터 로드
  const trades = loadTrades(dir);
  const pairs = matchTradePairs(trades);

  if (pairs.length < MIN_TRADES_FOR_TUNE) {
    const msg = `[AUTO-TUNE] 거래 수 부족으로 튜닝 스킵 (${pairs.length}/${MIN_TRADES_FOR_TUNE}건)`;
    return {
      success: false,
      message: msg,
      tradesAnalyzed: pairs.length,
      suggestions: {},
    };
  }

  // 2. 현재 전략 파라미터 로드
  const { DEFAULT_STRATEGY } = require('../config/strategy');
  const currentParams = { ...DEFAULT_STRATEGY };

  // 기존 auto-tune 결과가 있으면 그 위에서 시작
  const prevResult = loadAutoTuneResults(dir);
  if (prevResult?.suggestions) {
    for (const [key, suggestion] of Object.entries(prevResult.suggestions)) {
      if (suggestion.applied && suggestion.suggestedValue != null) {
        currentParams[key] = suggestion.suggestedValue;
      }
    }
  }

  // 3. 각 파라미터 분석
  const suggestions = {};
  const changes = [];

  for (const [paramName, paramConfig] of Object.entries(TUNE_PARAMS)) {
    const currentValue = currentParams[paramName];
    if (currentValue == null) continue;

    const analysis = analyzeParameter(pairs, paramName, paramConfig, currentValue);

    // 안전 제약 적용: ±20% 변경 제한
    const clamped = clampChange(currentValue, analysis.suggestedValue, MAX_CHANGE_PCT);

    // 신뢰도 + 샘플 수 체크
    const shouldApply = analysis.confidence >= MIN_CONFIDENCE
      && analysis.sampleSize >= MIN_SAMPLE_SIZE
      && clamped !== currentValue;

    suggestions[paramName] = {
      currentValue,
      suggestedValue: clamped,
      rawSuggested: analysis.suggestedValue,
      confidence: analysis.confidence,
      sampleSize: analysis.sampleSize,
      reasoning: analysis.reasoning,
      applied: shouldApply,
      description: paramConfig.description,
    };

    if (shouldApply) {
      changes.push({
        param: paramName,
        from: currentValue,
        to: clamped,
        confidence: analysis.confidence,
        sampleSize: analysis.sampleSize,
        reasoning: analysis.reasoning,
      });
    }
  }

  // 4. 결과 저장
  const result = {
    tunedAt: Date.now(),
    tunedDate: new Date().toISOString(),
    tradesAnalyzed: pairs.length,
    totalTrades: trades.length,
    suggestions,
    changes,
    changesApplied: changes.length,
  };

  saveAutoTuneResults(result, dir);

  // 5. 결과 메시지 생성
  const msg = changes.length > 0
    ? `[AUTO-TUNE] ${changes.length}개 파라미터 조정 제안 (${pairs.length}거래 분석)`
    : `[AUTO-TUNE] 변경 제안 없음 (${pairs.length}거래 분석, 신뢰도/샘플 부족)`;

  return {
    success: true,
    message: msg,
    tradesAnalyzed: pairs.length,
    suggestions,
    changes,
  };
}

// ─── 자동 튜닝 스케줄 체크 ───

function shouldAutoTune(logDir = null) {
  const dir = logDir || DEFAULT_LOG_DIR;

  try {
    const resultPath = path.join(dir, AUTO_TUNE_FILE);
    if (!fs.existsSync(resultPath)) return true; // 한 번도 안 했으면 실행

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    const lastTune = result.tunedAt || 0;
    const daysSinceTune = (Date.now() - lastTune) / (1000 * 60 * 60 * 24);

    return daysSinceTune >= TUNE_INTERVAL_DAYS;
  } catch {
    return true; // 파일 읽기 실패 시 실행
  }
}

// ─── 결과 저장/로드 ───

function saveAutoTuneResults(result, logDir) {
  const dir = logDir || DEFAULT_LOG_DIR;
  const resultPath = path.join(dir, AUTO_TUNE_FILE);
  const dirPath = path.dirname(resultPath);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
}

function loadAutoTuneResults(logDir = null) {
  try {
    const dir = logDir || DEFAULT_LOG_DIR;
    const resultPath = path.join(dir, AUTO_TUNE_FILE);
    if (!fs.existsSync(resultPath)) return null;
    return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = {
  autoTune,
  shouldAutoTune,
  loadAutoTuneResults,
  TUNE_PARAMS,
  MIN_TRADES_FOR_TUNE,
};
