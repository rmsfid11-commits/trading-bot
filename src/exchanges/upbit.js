const ccxt = require('ccxt');
const { EXCHANGE_CONFIG } = require('../config/exchanges');
const { logger } = require('../logger/trade-logger');

const TAG = 'UPBIT';

class UpbitExchange {
  constructor(credentials = null) {
    const creds = credentials || EXCHANGE_CONFIG.upbit;
    this.exchange = new ccxt.upbit({
      apiKey: creds.accessKey,
      secret: creds.secretKey,
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

  /**
   * 지정가 매수 (Limit Buy)
   * - 현재가보다 -0.1% 낮은 가격으로 지정가 주문
   * - 30초 내 미체결 시 취소 후 시장가 폴백
   * @param {string} symbol - 종목 (예: 'BTC/KRW')
   * @param {number} amount - 매수 금액 (KRW)
   * @param {number} price - 목표 가격 (지정가 기준)
   * @returns {Object|null} 체결 결과
   */
  async buyLimit(symbol, amount, price) {
    const PRICE_OFFSET_PCT = 0.001; // -0.1% 슬리피지 오프셋
    const FILL_TIMEOUT_MS = 30000;  // 30초 체결 대기

    try {
      // 지정가 = 목표가의 -0.1% (유리한 가격에 체결 시도)
      const limitPrice = Math.floor(price * (1 - PRICE_OFFSET_PCT));
      const quantity = amount / limitPrice;

      logger.info(TAG, `지정가 매수 시도 (${symbol}): 가격 ${limitPrice.toLocaleString()}원, 수량 ${quantity.toFixed(8)}`);

      const order = await this.exchange.createLimitBuyOrder(symbol, quantity, limitPrice);
      if (!order || !order.id) {
        logger.warn(TAG, `지정가 매수 주문 실패 (${symbol}) → 시장가 폴백`);
        return await this.buy(symbol, amount);
      }

      // 30초간 체결 대기
      const startTime = Date.now();
      while (Date.now() - startTime < FILL_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 3000)); // 3초마다 체크

        try {
          const status = await this.exchange.fetchOrder(order.id, symbol);
          if (status.status === 'closed') {
            // 체결 완료
            const avgPrice = status.average || limitPrice;
            const filledQty = status.filled || quantity;

            logger.info(TAG, `지정가 매수 체결 (${symbol}): ${avgPrice.toLocaleString()}원 × ${filledQty.toFixed(8)}`);
            logger.logTrade({
              symbol, action: 'BUY', price: avgPrice,
              quantity: filledQty, amount, reason: '지정가 매수 체결', pnl: null,
            });

            return { orderId: status.id, price: avgPrice, quantity: filledQty, amount, orderType: 'limit' };
          }

          if (status.status === 'canceled') {
            logger.warn(TAG, `지정가 매수 외부 취소 (${symbol}) → 시장가 폴백`);
            return await this.buy(symbol, amount);
          }
        } catch (e) {
          // 주문 상태 조회 실패 → 계속 대기
        }
      }

      // 타임아웃: 미체결 주문 취소 → 시장가 폴백
      logger.warn(TAG, `지정가 매수 타임아웃 (${symbol}, ${FILL_TIMEOUT_MS / 1000}초) → 취소 후 시장가 폴백`);
      try {
        await this.exchange.cancelOrder(order.id, symbol);
      } catch (cancelErr) {
        logger.warn(TAG, `지정가 매수 취소 실패 (${symbol}): ${cancelErr.message}`);
        // 취소 실패 = 이미 체결됐을 수 있음 → 상태 재확인
        try {
          const recheck = await this.exchange.fetchOrder(order.id, symbol);
          if (recheck.status === 'closed') {
            const avgPrice = recheck.average || limitPrice;
            const filledQty = recheck.filled || quantity;
            logger.info(TAG, `지정가 매수 체결 확인 (${symbol}): 취소 시도 중 체결됨`);
            return { orderId: recheck.id, price: avgPrice, quantity: filledQty, amount, orderType: 'limit' };
          }
        } catch { /* ignore */ }
      }

      // 시장가 폴백
      logger.info(TAG, `시장가 매수 폴백 실행 (${symbol})`);
      const marketResult = await this.buy(symbol, amount);
      if (marketResult) marketResult.orderType = 'market_fallback';
      return marketResult;

    } catch (error) {
      logger.error(TAG, `지정가 매수 실패 (${symbol}): ${error.message} → 시장가 폴백`);
      const marketResult = await this.buy(symbol, amount);
      if (marketResult) marketResult.orderType = 'market_fallback';
      return marketResult;
    }
  }

  /**
   * 지정가 매도 (Limit Sell)
   * - 현재가보다 +0.1% 높은 가격으로 지정가 주문
   * - 30초 내 미체결 시 취소 후 시장가 폴백
   * @param {string} symbol - 종목
   * @param {number} quantity - 매도 수량
   * @param {number} price - 목표 가격
   * @returns {Object|null} 체결 결과
   */
  async sellLimit(symbol, quantity, price) {
    const PRICE_OFFSET_PCT = 0.001; // +0.1% 슬리피지 오프셋
    const FILL_TIMEOUT_MS = 30000;  // 30초 체결 대기

    try {
      // 지정가 = 목표가의 +0.1% (유리한 가격에 체결 시도)
      const limitPrice = Math.ceil(price * (1 + PRICE_OFFSET_PCT));

      logger.info(TAG, `지정가 매도 시도 (${symbol}): 가격 ${limitPrice.toLocaleString()}원, 수량 ${quantity.toFixed(8)}`);

      const order = await this.exchange.createLimitSellOrder(symbol, quantity, limitPrice);
      if (!order || !order.id) {
        logger.warn(TAG, `지정가 매도 주문 실패 (${symbol}) → 시장가 폴백`);
        return await this.sell(symbol, quantity);
      }

      // 30초간 체결 대기
      const startTime = Date.now();
      while (Date.now() - startTime < FILL_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 3000));

        try {
          const status = await this.exchange.fetchOrder(order.id, symbol);
          if (status.status === 'closed') {
            const avgPrice = status.average || limitPrice;
            const filledQty = status.filled || quantity;

            logger.info(TAG, `지정가 매도 체결 (${symbol}): ${avgPrice.toLocaleString()}원 × ${filledQty.toFixed(8)}`);
            return { orderId: status.id, price: avgPrice, quantity: filledQty, amount: avgPrice * filledQty, orderType: 'limit' };
          }

          if (status.status === 'canceled') {
            logger.warn(TAG, `지정가 매도 외부 취소 (${symbol}) → 시장가 폴백`);
            return await this.sell(symbol, quantity);
          }
        } catch (e) { /* 상태 조회 실패 → 계속 대기 */ }
      }

      // 타임아웃: 미체결 취소 → 시장가 폴백
      logger.warn(TAG, `지정가 매도 타임아웃 (${symbol}, ${FILL_TIMEOUT_MS / 1000}초) → 취소 후 시장가 폴백`);
      try {
        await this.exchange.cancelOrder(order.id, symbol);
      } catch (cancelErr) {
        logger.warn(TAG, `지정가 매도 취소 실패 (${symbol}): ${cancelErr.message}`);
        try {
          const recheck = await this.exchange.fetchOrder(order.id, symbol);
          if (recheck.status === 'closed') {
            const avgPrice = recheck.average || limitPrice;
            const filledQty = recheck.filled || quantity;
            logger.info(TAG, `지정가 매도 체결 확인 (${symbol}): 취소 시도 중 체결됨`);
            return { orderId: recheck.id, price: avgPrice, quantity: filledQty, amount: avgPrice * filledQty, orderType: 'limit' };
          }
        } catch { /* ignore */ }
      }

      // 시장가 폴백
      logger.info(TAG, `시장가 매도 폴백 실행 (${symbol})`);
      const marketResult = await this.sell(symbol, quantity);
      if (marketResult) marketResult.orderType = 'market_fallback';
      return marketResult;

    } catch (error) {
      logger.error(TAG, `지정가 매도 실패 (${symbol}): ${error.message} → 시장가 폴백`);
      const marketResult = await this.sell(symbol, quantity);
      if (marketResult) marketResult.orderType = 'market_fallback';
      return marketResult;
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
