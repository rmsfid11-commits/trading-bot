class BaseStrategy {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
  }

  analyze(candles, indicators) {
    return { action: 'HOLD', reasons: ['미구현 전략'], scores: { buy: 0, sell: 0 } };
  }

  getName() {
    return this.name;
  }
}

module.exports = { BaseStrategy };
