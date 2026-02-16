const { BaseStrategy } = require('./base');

class GridStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('grid', config);
    this.gridLines = new Map(); // symbol → { lines, filledBuys, filledSells }
  }

  setupGrid(symbol, lowerPrice, upperPrice, gridCount = 10, amountPerGrid = 50000) {
    const step = (upperPrice - lowerPrice) / gridCount;
    const lines = [];
    for (let i = 0; i <= gridCount; i++) {
      lines.push({
        price: Math.round(lowerPrice + step * i),
        bought: false,
        sold: false,
      });
    }

    this.gridLines.set(symbol, {
      lines,
      lowerPrice,
      upperPrice,
      gridCount,
      amountPerGrid,
      step,
      lastPrice: null,
    });

    return lines;
  }

  analyze(candles, _indicators, symbol) {
    if (!candles || candles.length < 2) {
      return { action: 'HOLD', reasons: ['데이터 부족'], scores: { buy: 0, sell: 0 } };
    }

    const currentPrice = candles[candles.length - 1].close;
    const prevPrice = candles[candles.length - 2].close;

    // Auto-setup grid if not configured
    if (!this.gridLines.has(symbol)) {
      const closes = candles.map(c => c.close);
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const margin = (max - min) * 0.1;
      this.setupGrid(symbol, min - margin, max + margin, 10);
    }

    const grid = this.gridLines.get(symbol);
    const reasons = [];
    let action = 'HOLD';
    let buyScore = 0;
    let sellScore = 0;

    // Check each grid line for crossovers
    for (const line of grid.lines) {
      // Price crossed below grid line (buy signal)
      if (prevPrice >= line.price && currentPrice < line.price && !line.bought) {
        buyScore += 2;
        line.bought = true;
        line.sold = false;
        reasons.push(`그리드 매수 라인 돌파 (${line.price.toLocaleString()}원)`);
        break;
      }
      // Price crossed above grid line (sell signal)
      if (prevPrice <= line.price && currentPrice > line.price && !line.sold && line.bought) {
        sellScore += 3;
        line.sold = true;
        line.bought = false;
        reasons.push(`그리드 매도 라인 돌파 (${line.price.toLocaleString()}원)`);
        break;
      }
    }

    // Out of range warning
    if (currentPrice < grid.lowerPrice) {
      reasons.push('가격이 그리드 하한 이탈');
    } else if (currentPrice > grid.upperPrice) {
      reasons.push('가격이 그리드 상한 이탈');
    }

    grid.lastPrice = currentPrice;

    if (buyScore >= 2) action = 'BUY';
    else if (sellScore >= 3) action = 'SELL';

    return {
      action,
      reasons,
      indicators: {
        price: currentPrice,
        gridLower: grid.lowerPrice,
        gridUpper: grid.upperPrice,
        gridCount: grid.gridCount,
        gridStep: Math.round(grid.step),
      },
      scores: { buy: buyScore, sell: sellScore },
    };
  }

  getGridInfo(symbol) {
    return this.gridLines.get(symbol) || null;
  }
}

module.exports = { GridStrategy };
