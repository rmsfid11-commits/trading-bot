const { BaseStrategy } = require('./base');
const { calculateRSI } = require('../indicators/rsi');

class DCAStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('dca', config);
    this.buyInterval = config.buyIntervalMs || 3600000; // 1 hour default
    this.dipThreshold = config.dipThreshold || -3; // Buy on 3% dip
    this.takeProfitPct = config.takeProfitPct || 5;
    this.maxBuys = config.maxBuys || 5;
    this.dcaState = new Map(); // symbol → { buys, lastBuyTime, avgPrice, totalAmount, totalQty }
  }

  analyze(candles, _indicators, symbol) {
    if (!candles || candles.length < 20) {
      return { action: 'HOLD', reasons: ['데이터 부족'], scores: { buy: 0, sell: 0 } };
    }

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes);

    if (!this.dcaState.has(symbol)) {
      this.dcaState.set(symbol, {
        buys: 0,
        lastBuyTime: 0,
        avgPrice: 0,
        totalAmount: 0,
        totalQty: 0,
      });
    }

    const state = this.dcaState.get(symbol);
    const reasons = [];
    let buyScore = 0;
    let sellScore = 0;

    // Check take profit on existing position
    if (state.buys > 0 && state.avgPrice > 0) {
      const pnlPct = ((currentPrice - state.avgPrice) / state.avgPrice) * 100;
      if (pnlPct >= this.takeProfitPct) {
        sellScore += 5;
        reasons.push(`DCA 목표 수익률 도달 (${pnlPct.toFixed(2)}%)`);
        return {
          action: 'SELL',
          reasons,
          indicators: { price: currentPrice, avgPrice: state.avgPrice, pnlPct: Math.round(pnlPct * 100) / 100, buys: state.buys },
          scores: { buy: 0, sell: sellScore },
        };
      }
    }

    // Check buy conditions
    const timeSinceLastBuy = Date.now() - state.lastBuyTime;
    const canBuy = state.buys < this.maxBuys && timeSinceLastBuy >= this.buyInterval;

    if (canBuy) {
      // First buy: just buy if RSI is not extremely high
      if (state.buys === 0) {
        if (!rsi || rsi < 65) {
          buyScore += 2;
          reasons.push('DCA 초기 매수');
        }
      } else {
        // Subsequent buys: buy on dip from average price
        const dipFromAvg = ((currentPrice - state.avgPrice) / state.avgPrice) * 100;
        if (dipFromAvg <= this.dipThreshold) {
          buyScore += 3;
          reasons.push(`DCA 추가 매수 (평균 대비 ${dipFromAvg.toFixed(1)}% 하락)`);
        }

        // Also buy on RSI oversold
        if (rsi && rsi < 30) {
          buyScore += 1;
          reasons.push(`RSI 극과매도 (${rsi.toFixed(1)})`);
        }
      }
    } else if (state.buys >= this.maxBuys) {
      reasons.push(`DCA 최대 매수 횟수 도달 (${this.maxBuys}회)`);
    }

    let action = 'HOLD';
    if (buyScore >= 2) action = 'BUY';
    else if (sellScore >= 3) action = 'SELL';

    return {
      action,
      reasons,
      indicators: {
        price: currentPrice,
        rsi: rsi ? Math.round(rsi * 10) / 10 : null,
        dcaBuys: state.buys,
        dcaAvgPrice: state.avgPrice > 0 ? Math.round(state.avgPrice) : null,
        dcaMaxBuys: this.maxBuys,
      },
      scores: { buy: Math.round(buyScore * 10) / 10, sell: Math.round(sellScore * 10) / 10 },
    };
  }

  recordBuy(symbol, price, quantity, amount) {
    const state = this.dcaState.get(symbol) || { buys: 0, lastBuyTime: 0, avgPrice: 0, totalAmount: 0, totalQty: 0 };
    state.totalAmount += amount;
    state.totalQty += quantity;
    state.avgPrice = state.totalAmount / state.totalQty;
    state.buys += 1;
    state.lastBuyTime = Date.now();
    this.dcaState.set(symbol, state);
  }

  recordSell(symbol) {
    this.dcaState.delete(symbol);
  }

  getState(symbol) {
    return this.dcaState.get(symbol) || null;
  }
}

module.exports = { DCAStrategy };
