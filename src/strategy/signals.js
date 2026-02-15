const { calculateRSI } = require('../indicators/rsi');
const { calculateBollinger } = require('../indicators/bollinger');
const { analyzeVolume } = require('../indicators/volume');
const { calculateMACD } = require('../indicators/macd');
const { calculateVWAP } = require('../indicators/vwap');
const { detectCandlePatterns, getPatternScore } = require('../indicators/patterns');
const { detectChartPatterns, getChartPatternScore } = require('../indicators/chart-patterns');
const { checkVolatilityBreakout } = require('../indicators/volatility-breakout');
const { STRATEGY } = require('../config/strategy');
const { loadWeights } = require('../learning/weights');

// 동적 가중치 로드 (캐시, 60초마다 갱신)
let cachedWeights = null;
let weightsCacheTime = 0;
function getWeights() {
  if (!cachedWeights || Date.now() - weightsCacheTime > 60000) {
    cachedWeights = loadWeights();
    weightsCacheTime = Date.now();
  }
  return cachedWeights;
}

/**
 * @param {Array} candles
 * @param {Object} [options] - { regime, buyThresholdMult, mtfBoost, mtfSignal, sentimentBuyBoost, sentimentSellBoost }
 */
function generateSignal(candles, options = {}) {
  if (!candles || candles.length < STRATEGY.BOLLINGER_PERIOD + 1) {
    return { action: 'HOLD', reasons: ['데이터 부족'] };
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const currentPrice = closes[closes.length - 1];

  const rsi = calculateRSI(closes);
  const bollinger = calculateBollinger(closes);
  const volume = analyzeVolume(volumes);
  const macd = calculateMACD(candles);

  if (!rsi || !bollinger) {
    return { action: 'HOLD', reasons: ['지표 계산 불가'] };
  }

  const w = getWeights();
  const reasons = [];
  let buyScore = 0;
  let sellScore = 0;

  // ─── 기존 시그널 (동적 가중치) ───

  // RSI
  if (rsi <= STRATEGY.RSI_OVERSOLD) {
    buyScore += w.RSI_BUY;
    reasons.push(`RSI 과매도 (${rsi.toFixed(1)})`);
  } else if (rsi >= STRATEGY.RSI_OVERBOUGHT) {
    sellScore += w.RSI_SELL;
    reasons.push(`RSI 과매수 (${rsi.toFixed(1)})`);
  }

  // 볼린저밴드
  const bandWidth = bollinger.upper - bollinger.lower;
  const pricePosition = (currentPrice - bollinger.lower) / bandWidth;
  if (currentPrice <= bollinger.lower) {
    buyScore += w.BB_TOUCH_BUY;
    reasons.push('볼밴 하단 터치');
  } else if (pricePosition <= 0.3) {
    buyScore += w.BB_NEAR_BUY;
    reasons.push(`볼밴 하단 근접 (${(pricePosition * 100).toFixed(0)}%)`);
  } else if (currentPrice >= bollinger.upper) {
    sellScore += w.BB_SELL;
    reasons.push('볼밴 상단 터치');
  }

  // 거래량
  if (volume.isHigh) {
    buyScore += w.VOL_BUY;
    sellScore += w.VOL_SELL;
    reasons.push(`거래량 급등 (${volume.ratio}x)`);
  }

  // MACD
  if (macd) {
    if (macd.bullish) { buyScore += w.MACD_BUY; reasons.push('MACD 골든크로스'); }
    if (macd.bearish) { sellScore += w.MACD_SELL; reasons.push('MACD 데드크로스'); }
    if (macd.trend === 'UP') buyScore += w.MACD_TREND;

    // MACD 다이버전스 (강력한 반전 시그널)
    if (macd.divergence) {
      if (macd.divergence.type === 'bullish') {
        buyScore += macd.divergence.score;
        reasons.push('MACD 강세 다이버전스');
      } else if (macd.divergence.type === 'bearish') {
        sellScore += Math.abs(macd.divergence.score);
        reasons.push('MACD 약세 다이버전스');
      }
    }
  }

  // ─── 캔들스틱 패턴 ───

  const trendContext = rsi < 40 ? 'down' : rsi > 60 ? 'up' : 'neutral';
  const candlePatterns = detectCandlePatterns(candles);
  const candleScore = getPatternScore(candlePatterns, trendContext);
  buyScore += candleScore.buyScore;
  sellScore += candleScore.sellScore;

  if (candlePatterns.length > 0) {
    const pNames = candlePatterns.map(p => `${p.emoji}${p.name}`).join(', ');
    reasons.push(`패턴: ${pNames}`);
  }

  // ─── 차트 패턴 ───

  const chartPatterns = detectChartPatterns(candles);
  const chartScore = getChartPatternScore(chartPatterns);
  buyScore += chartScore.buyScore;
  sellScore += chartScore.sellScore;

  if (chartPatterns.length > 0) {
    for (const cp of chartPatterns) {
      reasons.push(`${cp.emoji}${cp.name}${cp.detail ? ' (' + cp.detail + ')' : ''}`);
    }
  }

  // ─── 변동성 돌파 ───

  const vb = checkVolatilityBreakout(candles);
  if (vb.score > 0) {
    buyScore += vb.score;
    reasons.push(`변동성돌파 (K${vb.kUsed}, +${vb.score.toFixed(1)})`);
  } else if (vb.score < 0) {
    sellScore += Math.abs(vb.score);
    reasons.push(`변동성하락돌파`);
  }

  // ─── 호가창 점수 ───

  const obScore = options.orderbookScore || 0;
  if (obScore > 0.3) {
    buyScore += obScore;
    reasons.push(`호가 매수우세 (+${obScore.toFixed(1)})`);
  } else if (obScore < -0.3) {
    sellScore += Math.abs(obScore);
    reasons.push(`호가 매도우세 (${obScore.toFixed(1)})`);
  }

  // ─── 김프 부스트 ───

  const kimchiBuy = options.kimchiBuyBoost || 0;
  const kimchiSell = options.kimchiSellBoost || 0;
  if (kimchiBuy > 0) {
    buyScore += kimchiBuy;
    reasons.push(`김프 할인 (+${kimchiBuy.toFixed(1)})`);
  }
  if (kimchiSell > 0) {
    sellScore += kimchiSell;
    reasons.push(`김프 과열 (+${kimchiSell.toFixed(1)})`);
  }

  // ─── VWAP ───

  const vwap = calculateVWAP(candles);
  if (vwap) {
    if (vwap.score > 0) {
      buyScore += vwap.score;
      reasons.push(`VWAP 하단 (${vwap.deviation > 0 ? '+' : ''}${vwap.deviation}%)`);
    } else if (vwap.score < 0) {
      sellScore += Math.abs(vwap.score);
      reasons.push(`VWAP 상단 (${vwap.deviation > 0 ? '+' : ''}${vwap.deviation}%)`);
    }
  }

  // ─── 멀티 타임프레임 부스트 ───

  const mtfBoost = options.mtfBoost || 0;
  const mtfSignal = options.mtfSignal || 'neutral';

  if (mtfBoost > 0) {
    if (mtfSignal.includes('buy')) {
      buyScore += mtfBoost;
      reasons.push(`MTF 정렬 (${mtfSignal})`);
    } else if (mtfSignal.includes('sell')) {
      sellScore += mtfBoost;
      reasons.push(`MTF 정렬 (${mtfSignal})`);
    }
  }

  // ─── 감성 분석 부스트 ───

  const sentBuyBoost = options.sentimentBuyBoost || 0;
  const sentSellBoost = options.sentimentSellBoost || 0;

  if (sentBuyBoost > 0) {
    buyScore += sentBuyBoost;
    reasons.push(`감성 긍정 (+${sentBuyBoost.toFixed(1)})`);
  }
  if (sentSellBoost > 0) {
    sellScore += sentSellBoost;
    reasons.push(`감성 부정 (+${sentSellBoost.toFixed(1)})`);
  }

  // ─── 최종 결정 ───

  const buyThresholdMult = options.buyThresholdMult || 1.0;
  const buyThreshold = 2 * buyThresholdMult;

  let action = 'HOLD';
  if (buyScore >= buyThreshold) action = 'BUY';
  else if (sellScore >= 3) action = 'SELL';

  // 스냅샷
  const snapshot = {
    rsi: Math.round(rsi * 10) / 10,
    bbPosition: Math.round(pricePosition * 100) / 100,
    bbWidth: Math.round(bollinger.bandwidth * 100) / 100,
    volumeRatio: volume.ratio,
    volumeHigh: volume.isHigh,
    macdHistogram: macd?.histogram || 0,
    macdBullish: macd?.bullish || false,
    macdTrend: macd?.trend || 'FLAT',
    price: currentPrice,
    buyScore: Math.round(buyScore * 100) / 100,
    sellScore: Math.round(sellScore * 100) / 100,
    regime: options.regime || 'unknown',
    candlePatterns: candlePatterns.map(p => p.name),
    chartPatterns: chartPatterns.map(p => p.name),
    mtfSignal,
    sentimentBuyBoost: sentBuyBoost,
    sentimentSellBoost: sentSellBoost,
    volatilityBreakout: vb.signal || 'NONE',
    orderbookScore: obScore,
    kimchiBuyBoost: kimchiBuy,
    kimchiSellBoost: kimchiSell,
    vwap: vwap ? { vwap: vwap.vwap, deviation: vwap.deviation, signal: vwap.signal } : null,
    macdDivergence: macd?.divergence?.type || 'none',
  };

  return {
    action,
    reasons,
    indicators: {
      rsi: Math.round(rsi * 10) / 10,
      bollinger: {
        upper: Math.round(bollinger.upper),
        middle: Math.round(bollinger.middle),
        lower: Math.round(bollinger.lower),
      },
      volume: volume.ratio,
      macd: macd || null,
      vwap: vwap || null,
      price: currentPrice,
    },
    scores: { buy: buyScore, sell: sellScore },
    patterns: {
      candle: candlePatterns,
      chart: chartPatterns,
    },
    snapshot,
  };
}

module.exports = { generateSignal };
