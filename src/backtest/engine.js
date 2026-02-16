const { generateSignal } = require('../strategy/signals');
const { IchimokuStrategy } = require('../strategy/ichimoku');
const { GridStrategy } = require('../strategy/grid');
const { DCAStrategy } = require('../strategy/dca');
const { calculateATR } = require('../indicators/atr');

/**
 * ComboWrapper: generateSignal을 BaseStrategy 인터페이스로 래핑
 */
class ComboWrapper {
  constructor() { this.name = 'combo'; }
  analyze(candles) { return generateSignal(candles); }
}

class BacktestEngine {
  constructor(options = {}) {
    this.initialCapital = options.initialCapital || 1000000;
    this.positionPct = options.positionPct || 20;
    this.stopLossPct = options.stopLossPct || -2;
    this.takeProfitPct = options.takeProfitPct || 5;
    this.useATRStops = options.useATRStops !== false;
    this.commission = options.commission || 0.05; // 0.05% Upbit fee
    this.strategyName = options.strategy || 'combo';
  }

  _createStrategy() {
    switch (this.strategyName) {
      case 'ichimoku': return new IchimokuStrategy();
      case 'grid': return new GridStrategy();
      case 'dca': return new DCAStrategy();
      case 'combo':
      default: return new ComboWrapper();
    }
  }

  run(candles, symbol = 'BTC/KRW') {
    if (!candles || candles.length < 50) {
      return { error: '캔들 데이터 부족 (최소 50개 필요)' };
    }

    const strategy = this._createStrategy();
    let capital = this.initialCapital;
    let position = null;
    const trades = [];
    const equityCurve = [];
    let peakEquity = capital;
    let maxDrawdown = 0;

    for (let i = 50; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const current = candles[i];
      const currentPrice = current.close;

      // Calculate equity
      const equity = position
        ? capital + position.quantity * currentPrice - position.quantity * position.entryPrice
        : capital;

      equityCurve.push({
        time: current.timestamp,
        equity: Math.round(equity),
        price: currentPrice,
      });

      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      // Check existing position
      if (position) {
        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // Trailing stop update
        if (currentPrice > position.highestPrice) {
          position.highestPrice = currentPrice;
          const newStop = currentPrice * (1 + this.stopLossPct / 100);
          if (newStop > position.stopLoss) position.stopLoss = newStop;
        }

        let exitReason = null;
        if (currentPrice <= position.stopLoss) exitReason = `손절 (${pnlPct.toFixed(2)}%)`;
        else if (currentPrice >= position.takeProfit) exitReason = `익절 (${pnlPct.toFixed(2)}%)`;

        if (exitReason) {
          const fee = currentPrice * position.quantity * (this.commission / 100);
          const pnl = (currentPrice - position.entryPrice) * position.quantity - fee - position.fee;
          capital += position.amount + pnl;

          trades.push({
            type: 'SELL',
            symbol,
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            quantity: position.quantity,
            pnlPct: Math.round(pnlPct * 100) / 100,
            pnlAmount: Math.round(pnl),
            reason: exitReason,
            entryTime: position.entryTime,
            exitTime: current.timestamp,
            holdBars: i - position.entryBar,
          });
          position = null;
          continue;
        }
      }

      // Generate signal
      const signal = strategy.analyze(window, null, symbol);

      // Buy
      if (signal.action === 'BUY' && !position) {
        const amount = Math.floor(capital * (this.positionPct / 100));
        if (amount < 5000 || amount > capital) continue;

        const fee = amount * (this.commission / 100);
        const quantity = (amount - fee) / currentPrice;

        let stopLoss, takeProfit;
        if (this.useATRStops) {
          const atr = calculateATR(window);
          if (atr) {
            stopLoss = currentPrice - atr.atr * 1.5;
            takeProfit = currentPrice + atr.atr * 2.5;
          }
        }
        if (!stopLoss) {
          stopLoss = currentPrice * (1 + this.stopLossPct / 100);
          takeProfit = currentPrice * (1 + this.takeProfitPct / 100);
        }

        capital -= amount;
        position = {
          entryPrice: currentPrice,
          quantity,
          amount,
          fee,
          stopLoss,
          takeProfit,
          highestPrice: currentPrice,
          entryTime: current.timestamp,
          entryBar: i,
          reason: signal.reasons.join(', '),
        };

        trades.push({
          type: 'BUY',
          symbol,
          price: currentPrice,
          quantity,
          amount,
          reason: signal.reasons.join(', '),
          time: current.timestamp,
          scores: signal.scores,
        });
      }

      // Sell signal
      if (signal.action === 'SELL' && position) {
        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        const fee = currentPrice * position.quantity * (this.commission / 100);
        const pnl = (currentPrice - position.entryPrice) * position.quantity - fee - position.fee;
        capital += position.amount + pnl;

        trades.push({
          type: 'SELL',
          symbol,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          quantity: position.quantity,
          pnlPct: Math.round(pnlPct * 100) / 100,
          pnlAmount: Math.round(pnl),
          reason: signal.reasons.join(', '),
          entryTime: position.entryTime,
          exitTime: current.timestamp,
          holdBars: i - position.entryBar,
        });
        position = null;
      }
    }

    // Close any remaining position at last price
    if (position) {
      const lastPrice = candles[candles.length - 1].close;
      const pnlPct = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
      const fee = lastPrice * position.quantity * (this.commission / 100);
      const pnl = (lastPrice - position.entryPrice) * position.quantity - fee - position.fee;
      capital += position.amount + pnl;

      trades.push({
        type: 'SELL',
        symbol,
        entryPrice: position.entryPrice,
        exitPrice: lastPrice,
        quantity: position.quantity,
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlAmount: Math.round(pnl),
        reason: '백테스트 종료 (미체결 포지션 청산)',
        entryTime: position.entryTime,
        exitTime: candles[candles.length - 1].timestamp,
        holdBars: candles.length - 1 - position.entryBar,
      });
    }

    // Calculate statistics
    const sellTrades = trades.filter(t => t.type === 'SELL');
    const wins = sellTrades.filter(t => t.pnlPct > 0);
    const losses = sellTrades.filter(t => t.pnlPct <= 0);

    const totalReturn = ((capital - this.initialCapital) / this.initialCapital) * 100;
    const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
    const profitFactor = losses.length > 0 && avgLoss !== 0
      ? Math.abs((wins.reduce((s, t) => s + t.pnlAmount, 0)) / (losses.reduce((s, t) => s + t.pnlAmount, 0) || 1))
      : wins.length > 0 ? Infinity : 0;

    // Sharpe Ratio (simplified, annualized assuming 5min candles)
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
    }
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdReturn = returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
      : 0;
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252 * 288) : 0;

    return {
      strategy: this.strategyName,
      symbol,
      period: {
        start: candles[0].timestamp,
        end: candles[candles.length - 1].timestamp,
        candleCount: candles.length,
      },
      initialCapital: this.initialCapital,
      finalCapital: Math.round(capital),
      totalReturn: Math.round(totalReturn * 100) / 100,
      totalTrades: sellTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      trades,
      equityCurve,
    };
  }
}

module.exports = { BacktestEngine };
