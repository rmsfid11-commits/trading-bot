/**
 * 페이퍼 트레이딩 (모의 매매)
 *
 * 실제 거래소 API로 시세는 조회하되, 주문은 가상으로 처리
 * 실제 돈을 쓰지 않고 전략을 검증할 수 있음
 *
 * 사용: PAPER_TRADE=true 환경변수 설정
 */

const { logger } = require('../logger/trade-logger');

const TAG = 'PAPER';

class PaperExchange {
  /**
   * @param {Object} realExchange - 실제 UpbitExchange 인스턴스 (시세 조회용)
   * @param {number} initialBalance - 시작 가상 잔고 (원)
   */
  constructor(realExchange, initialBalance = 1000000) {
    this.real = realExchange;
    this.balance = initialBalance;
    this.initialBalance = initialBalance;
    this.holdings = {}; // symbol → { quantity, avgPrice }
    this.orderHistory = [];
    this.connected = false;
  }

  async connect() {
    const result = await this.real.connect();
    this.connected = result;
    if (result) {
      logger.info(TAG, `📝 페이퍼 트레이딩 모드 (가상 잔고: ${this.initialBalance.toLocaleString()}원)`);
    }
    return result;
  }

  // 시세 조회는 실제 거래소 사용
  async getCandles(symbol, interval, count) {
    return this.real.getCandles(symbol, interval, count);
  }

  async getTicker(symbol) {
    return this.real.getTicker(symbol);
  }

  // 잔고: 가상 잔고 반환
  async getBalance() {
    return { free: this.balance, total: this.balance + this.getHoldingsValue() };
  }

  // 매수: 가상 매수
  async buy(symbol, amount) {
    try {
      const ticker = await this.real.getTicker(symbol);
      if (!ticker) return null;

      if (amount > this.balance) {
        logger.warn(TAG, `가상 매수 실패: 잔고 부족 (${Math.round(this.balance).toLocaleString()} < ${Math.round(amount).toLocaleString()})`);
        return null;
      }

      const price = ticker.price;
      const quantity = amount / price;
      const fee = amount * 0.0005; // 업비트 수수료 0.05%

      this.balance -= (amount + fee);

      if (!this.holdings[symbol]) {
        this.holdings[symbol] = { quantity: 0, avgPrice: 0, totalCost: 0 };
      }
      const h = this.holdings[symbol];
      h.totalCost += amount;
      h.quantity += quantity;
      h.avgPrice = h.totalCost / h.quantity;

      const order = {
        id: `paper_${Date.now()}`,
        symbol,
        side: 'buy',
        price,
        quantity,
        amount,
        fee,
        timestamp: Date.now(),
      };
      this.orderHistory.push(order);

      logger.info(TAG, `📝 가상 매수: ${symbol} @ ${price.toLocaleString()} × ${quantity.toFixed(8)} (${Math.round(amount).toLocaleString()}원)`);

      return { orderId: order.id, price, quantity, amount };
    } catch (error) {
      logger.error(TAG, `가상 매수 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  // 매도: 가상 매도
  async sell(symbol, quantity) {
    try {
      const ticker = await this.real.getTicker(symbol);
      if (!ticker) return null;

      const h = this.holdings[symbol];
      if (!h || h.quantity < quantity * 0.9) {
        logger.warn(TAG, `가상 매도 실패: ${symbol} 보유 수량 부족`);
        return null;
      }

      const price = ticker.price;
      const amount = price * quantity;
      const fee = amount * 0.0005;

      this.balance += (amount - fee);

      h.quantity -= quantity;
      h.totalCost -= h.avgPrice * quantity;
      if (h.quantity < 0.00000001) {
        delete this.holdings[symbol];
      }

      const order = {
        id: `paper_${Date.now()}`,
        symbol,
        side: 'sell',
        price,
        quantity,
        amount,
        fee,
        timestamp: Date.now(),
      };
      this.orderHistory.push(order);

      logger.info(TAG, `📝 가상 매도: ${symbol} @ ${price.toLocaleString()} × ${quantity.toFixed(8)} (${Math.round(amount).toLocaleString()}원)`);

      return { orderId: order.id, price, quantity, amount };
    } catch (error) {
      logger.error(TAG, `가상 매도 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  // 보유 코인 조회
  async getHoldings() {
    const result = {};
    for (const [symbol, h] of Object.entries(this.holdings)) {
      if (h.quantity > 0) result[symbol] = h.quantity;
    }
    return result;
  }

  async getDetailedHoldings() {
    const result = {};
    for (const [symbol, h] of Object.entries(this.holdings)) {
      if (h.quantity > 0) {
        result[symbol] = {
          quantity: h.quantity,
          avgBuyPrice: h.avgPrice,
        };
      }
    }
    return result;
  }

  async getAvgBuyPrice(symbol) {
    return this.holdings[symbol]?.avgPrice || null;
  }

  // 보유 코인 시가 평가
  getHoldingsValue() {
    let total = 0;
    for (const h of Object.values(this.holdings)) {
      total += h.quantity * h.avgPrice; // 평균매수가 기준 (실시간 평가는 별도)
    }
    return total;
  }

  isConnected() {
    return this.connected;
  }

  // 페이퍼 트레이딩 통계
  getStats() {
    const buys = this.orderHistory.filter(o => o.side === 'buy');
    const sells = this.orderHistory.filter(o => o.side === 'sell');
    const totalFees = this.orderHistory.reduce((s, o) => s + o.fee, 0);
    const holdingsValue = this.getHoldingsValue();

    return {
      mode: 'paper',
      initialBalance: this.initialBalance,
      currentBalance: Math.round(this.balance),
      holdingsValue: Math.round(holdingsValue),
      totalValue: Math.round(this.balance + holdingsValue),
      pnl: Math.round(this.balance + holdingsValue - this.initialBalance),
      pnlPct: Math.round(((this.balance + holdingsValue - this.initialBalance) / this.initialBalance) * 10000) / 100,
      totalBuys: buys.length,
      totalSells: sells.length,
      totalFees: Math.round(totalFees),
      holdingCount: Object.keys(this.holdings).length,
    };
  }
}

module.exports = { PaperExchange };
