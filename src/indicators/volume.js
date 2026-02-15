const { STRATEGY } = require('../config/strategy');

function analyzeVolume(volumes, threshold = STRATEGY.VOLUME_THRESHOLD) {
  if (volumes.length < 20) return { isHigh: false, ratio: 0, avg: 0 };

  const recent = volumes.slice(-20, -1);
  const avg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const current = volumes[volumes.length - 1];
  const ratio = avg > 0 ? current / avg : 0;

  return {
    isHigh: ratio >= threshold,
    ratio: Math.round(ratio * 100) / 100,
    avg: Math.round(avg),
    current,
  };
}

module.exports = { analyzeVolume };
