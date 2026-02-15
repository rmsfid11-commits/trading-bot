const ccxt = require('ccxt');
const { EXCHANGE_CONFIG } = require('../config/exchanges');
const { logger } = require('../logger/trade-logger');

const TAG = 'UPBIT';

class UpbitExchange {
  constructor() {
    this.exchange = new ccxt.upbit({
      apiKey: EXCHANGE_CONFIG.upbit.accessKey,
      secret: EXCHANGE_CONFIG.upbit.secretKey,
      enableRateLimit: true,
      options: { createMarketBuyOrderRequiresPrice: false },
    });
    this.connected = false;
  }

  async connect() {
    try {
      await this.exchange.loadMarkets();
      this.connected = true;
      logger.info(TAG, '업비트 연결 성공');
      return true;
    } catch (error) {
      logger.error(TAG, `연결 실패: ${error.message}`);
      this.connected = false;
      return false;
    }
  }

  async getCandles(symbol, interval = 'minutes/5', count = 200) {
    try {
      const tfMap = {
        'minutes/5': '5m', 'minutes/15': '15m', 'minutes/60': '1h', 'minutes/240': '4h',
        '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h',
      };
      const timeframe = tfMap[interval] || '1h';
      const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, count);
      return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
        timestamp, open, high, low, close, volume,
      }));
    } catch (error) {
      logger.error(TAG, `캔들 조회 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  async getTicker(symbol) {
    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      return {
        price: ticker.last,
        volume: ticker.baseVolume,
        change: ticker.percentage,
        high: ticker.high,
        low: ticker.low,
      };
    } catch (error) {
      logger.error(TAG, `시세 조회 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  async getBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      const krw = balance.free?.KRW || 0;
      const total = balance.total?.KRW || 0;
      return { free: krw, total, balances: balance };
    } catch (error) {
      logger.error(TAG, `잔고 조회 실패: ${error.message}`);
      return null;
    }
  }

  async buy(symbol, amount) {
    try {
      const ticker = await this.getTicker(symbol);
      if (!ticker) return null;

      // 업비트 시장가 매수: KRW 금액(cost)을 amount로 전달
      const order = await this.exchange.createMarketBuyOrder(symbol, amount);
      const quantity = order.filled || (amount / ticker.price);
      const avgPrice = order.average || ticker.price;

      logger.logTrade({
        symbol, action: 'BUY', price: avgPrice,
        quantity, amount, reason: '시그널 매수', pnl: null,
      });

      return { orderId: order.id, price: avgPrice, quantity, amount };
    } catch (error) {
      logger.error(TAG, `매수 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  async sell(symbol, quantity) {
    try {
      const ticker = await this.getTicker(symbol);
      if (!ticker) return null;

      const order = await this.exchange.createMarketSellOrder(symbol, quantity);

      return { orderId: order.id, price: ticker.price, quantity, amount: ticker.price * quantity };
    } catch (error) {
      logger.error(TAG, `매도 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  async getAvgBuyPrice(symbol) {
    try {
      // 업비트 매수평균가 조회 (fetchBalance에 avg_buy_price 포함)
      const balance = await this.exchange.fetchBalance();
      const currency = symbol.replace('/KRW', '');
      const info = balance.info || [];
      const entry = info.find(b => b.currency === currency);
      if (entry && entry.avg_buy_price) {
        return parseFloat(entry.avg_buy_price);
      }
      return null;
    } catch (error) {
      logger.error(TAG, `매수평균가 조회 실패 (${symbol}): ${error.message}`);
      return null;
    }
  }

  async getDetailedHoldings() {
    try {
      const balance = await this.exchange.fetchBalance();
      const holdings = {};
      const info = balance.info || [];
      for (const entry of info) {
        if (entry.currency === 'KRW') continue;
        const total = parseFloat(entry.balance) + parseFloat(entry.locked || 0);
        if (total <= 0) continue;
        const symbol = `${entry.currency}/KRW`;
        holdings[symbol] = {
          quantity: total,
          avgBuyPrice: parseFloat(entry.avg_buy_price) || 0,
        };
      }
      return holdings;
    } catch (error) {
      logger.error(TAG, `상세 보유 조회 실패: ${error.message}`);
      return null;
    }
  }

  async getHoldings() {
    try {
      const balance = await this.exchange.fetchBalance();
      const holdings = {};
      for (const [currency, amount] of Object.entries(balance.total || {})) {
        if (currency === 'KRW' || amount <= 0) continue;
        holdings[`${currency}/KRW`] = amount;
      }
      return holdings;
    } catch (error) {
      logger.error(TAG, `보유 코인 조회 실패: ${error.message}`);
      return null;
    }
  }

  isConnected() {
    return this.connected;
  }
}

module.exports = { UpbitExchange };
