const { BaseStrategy } = require('./base');
const { calculateIchimoku } = require('../indicators/ichimoku');
const { calculateRSI } = require('../indicators/rsi');
const { analyzeVolume } = require('../indicators/volume');

class IchimokuStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('ichimoku', config);
  }

  analyze(candles) {
    if (!candles || candles.length < 78) {
      return { action: 'HOLD', reasons: ['데이터 부족 (이치모쿠 최소 78캔들)'], scores: { buy: 0, sell: 0 } };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const currentPrice = closes[closes.length - 1];
    const ichimoku = calculateIchimoku(candles);
    const rsi = calculateRSI(closes);
    const volume = analyzeVolume(volumes);

    if (!ichimoku) {
      return { action: 'HOLD', reasons: ['이치모쿠 계산 불가'], scores: { buy: 0, sell: 0 } };
    }

    const reasons = [];
    let buyScore = 0;
    let sellScore = 0;

    // Cloud position
    if (ichimoku.aboveCloud) {
      buyScore += 2;
      reasons.push('가격이 구름 위');
    } else if (ichimoku.belowCloud) {
      sellScore += 2;
      reasons.push('가격이 구름 아래');
    } else {
      reasons.push('가격이 구름 안 (보합)');
    }

    // TK Cross
    if (ichimoku.tkCross) {
      buyScore += 2;
      reasons.push('전환선/기준선 골든크로스');
    }
    if (ichimoku.tkDeadCross) {
      sellScore += 2;
      reasons.push('전환선/기준선 데드크로스');
    }

    // Cloud direction
    if (ichimoku.bullishCloud) {
      buyScore += 0.5;
      reasons.push('구름 상승 (선행스팬A > B)');
    } else {
      sellScore += 0.5;
      reasons.push('구름 하락 (선행스팬A < B)');
    }

    // Price vs conversion line
    if (currentPrice > ichimoku.conversion) {
      buyScore += 0.5;
    } else {
      sellScore += 0.5;
    }

    // RSI confirmation
    if (rsi) {
      if (rsi < 35) buyScore += 1;
      if (rsi > 65) sellScore += 1;
    }

    // Volume confirmation
    if (volume.isHigh) {
      buyScore += 0.5;
      sellScore += 0.5;
      reasons.push(`거래량 급등 (${volume.ratio}x)`);
    }

    let action = 'HOLD';
    if (buyScore >= 3) action = 'BUY';
    else if (sellScore >= 3) action = 'SELL';

    return {
      action,
      reasons,
      indicators: {
        ichimoku: {
          conversion: Math.round(ichimoku.conversion),
          base: Math.round(ichimoku.base),
          spanA: Math.round(ichimoku.spanA),
          spanB: Math.round(ichimoku.spanB),
          cloudTop: Math.round(ichimoku.cloudTop),
          cloudBottom: Math.round(ichimoku.cloudBottom),
        },
        rsi: rsi ? Math.round(rsi * 10) / 10 : null,
        volume: volume.ratio,
        price: currentPrice,
      },
      scores: { buy: Math.round(buyScore * 10) / 10, sell: Math.round(sellScore * 10) / 10 },
    };
  }
}

module.exports = { IchimokuStrategy };
