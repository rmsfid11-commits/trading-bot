const { IchimokuCloud } = require('technicalindicators');

function calculateIchimoku(candles, conversionPeriod = 9, basePeriod = 26, spanPeriod = 52, displacement = 26) {
  if (candles.length < spanPeriod + displacement) return null;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const result = IchimokuCloud.calculate({
    high: highs,
    low: lows,
    conversionPeriod,
    basePeriod,
    spanPeriod,
    displacement,
  });

  if (!result || result.length < 2) return null;

  const last = result[result.length - 1];
  const prev = result[result.length - 2];
  const currentPrice = closes[closes.length - 1];

  const cloudTop = Math.max(last.spanA, last.spanB);
  const cloudBottom = Math.min(last.spanA, last.spanB);

  return {
    conversion: last.conversion,
    base: last.base,
    spanA: last.spanA,
    spanB: last.spanB,
    cloudTop,
    cloudBottom,
    aboveCloud: currentPrice > cloudTop,
    belowCloud: currentPrice < cloudBottom,
    inCloud: currentPrice >= cloudBottom && currentPrice <= cloudTop,
    bullishCloud: last.spanA > last.spanB,
    tkCross: prev.conversion <= prev.base && last.conversion > last.base,
    tkDeadCross: prev.conversion >= prev.base && last.conversion < last.base,
    currentPrice,
  };
}

module.exports = { calculateIchimoku };
