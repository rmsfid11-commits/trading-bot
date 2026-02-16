const { StochasticRSI } = require('technicalindicators');

function calculateStochasticRSI(closes, rsiPeriod = 14, stochasticPeriod = 14, kPeriod = 3, dPeriod = 3) {
  if (closes.length < rsiPeriod + stochasticPeriod) return null;

  const result = StochasticRSI.calculate({
    values: closes,
    rsiPeriod,
    stochasticPeriod,
    kPeriod,
    dPeriod,
  });

  if (!result || result.length < 2) return null;

  const last = result[result.length - 1];
  const prev = result[result.length - 2];

  if (last.k == null || last.d == null) return null;

  return {
    k: Math.round(last.k * 100) / 100,
    d: Math.round(last.d * 100) / 100,
    overbought: last.k > 80,
    oversold: last.k < 20,
    bullishCross: prev.k <= prev.d && last.k > last.d,
    bearishCross: prev.k >= prev.d && last.k < last.d,
  };
}

module.exports = { calculateStochasticRSI };
