const { STRATEGY } = require('../config/strategy');

function calculateBollinger(closes, period = STRATEGY.BOLLINGER_PERIOD, stdDev = STRATEGY.BOLLINGER_STD_DEV) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const sma = slice.reduce((sum, v) => sum + v, 0) / period;

  const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
  const sd = Math.sqrt(variance);

  return {
    upper: sma + stdDev * sd,
    middle: sma,
    lower: sma - stdDev * sd,
    bandwidth: ((sma + stdDev * sd) - (sma - stdDev * sd)) / sma * 100,
  };
}

module.exports = { calculateBollinger };
