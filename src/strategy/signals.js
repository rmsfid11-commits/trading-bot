const { calculateRSI } = require('../indicators/rsi');
const { calculateBollinger } = require('../indicators/bollinger');
const { analyzeVolume } = require('../indicators/volume');
const { calculateMACD } = require('../indicators/macd');
const { STRATEGY } = require('../config/strategy');

function generateSignal(candles) {
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

  const reasons = [];
  let buyScore = 0;
  let sellScore = 0;

  // RSI 신호
  if (rsi <= STRATEGY.RSI_OVERSOLD) {
    buyScore += 2;
    reasons.push(`RSI 과매도 (${rsi.toFixed(1)})`);
  } else if (rsi >= STRATEGY.RSI_OVERBOUGHT) {
    sellScore += 2;
    reasons.push(`RSI 과매수 (${rsi.toFixed(1)})`);
  }

  // 볼린저밴드 신호
  const bandWidth = bollinger.upper - bollinger.lower;
  const pricePosition = (currentPrice - bollinger.lower) / bandWidth; // 0=하단, 1=상단
  if (currentPrice <= bollinger.lower) {
    buyScore += 2;
    reasons.push('볼밴 하단 터치');
  } else if (pricePosition <= 0.3) {
    buyScore += 1;
    reasons.push(`볼밴 하단 근접 (${(pricePosition * 100).toFixed(0)}%)`);
  } else if (currentPrice >= bollinger.upper) {
    sellScore += 2;
    reasons.push('볼밴 상단 터치');
  }

  // 거래량 신호
  if (volume.isHigh) {
    buyScore += 1;
    sellScore += 1;
    reasons.push(`거래량 급등 (${volume.ratio}x)`);
  }

  // MACD 신호
  if (macd) {
    if (macd.bullish) {
      buyScore += 1;
      reasons.push('MACD 골든크로스');
    }
    if (macd.bearish) {
      sellScore += 1;
      reasons.push('MACD 데드크로스');
    }
    if (macd.trend === 'UP') {
      buyScore += 0.5;
    }
  }

  // 최종 결정
  let action = 'HOLD';
  if (buyScore >= 2) action = 'BUY';
  else if (sellScore >= 3) action = 'SELL';

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
      price: currentPrice,
    },
    scores: { buy: buyScore, sell: sellScore },
  };
}

module.exports = { generateSignal };
