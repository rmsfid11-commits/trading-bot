/**
 * 바이낸스 펀딩비 (Funding Rate) — 선행 지표
 *
 * 펀딩비 > 0.05% → 롱 과잉 → 하락 가능성 (매수 감점)
 * 펀딩비 < -0.02% → 숏 과잉 → 숏스퀴즈 가능성 (매수 가점)
 * 8시간마다 갱신 (00:00, 08:00, 16:00 UTC)
 *
 * Binance API (무료, 인증 불필요)
 */

const https = require('https');

let cache = { rates: {}, lastUpdate: 0 };
const UPDATE_INTERVAL = 300000; // 5분 캐시

// 업비트 심볼 → 바이낸스 심볼 변환
function toBindanceSymbol(upbitSymbol) {
  return upbitSymbol.replace('/KRW', 'USDT');
}

/**
 * 바이낸스 펀딩비 조회 (전 종목 한번에)
 * @returns {Promise<Object>} { 'BTCUSDT': 0.0001, ... }
 */
function fetchFundingRates() {
  if (Date.now() - cache.lastUpdate < UPDATE_INTERVAL && Object.keys(cache.rates).length > 0) {
    return Promise.resolve(cache.rates);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(cache.rates), 5000);

    https.get('https://fapi.binance.com/fapi/v1/premiumIndex', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          const rates = {};
          for (const item of json) {
            rates[item.symbol] = parseFloat(item.lastFundingRate);
          }
          cache = { rates, lastUpdate: Date.now() };
          resolve(rates);
        } catch { resolve(cache.rates); }
      });
    }).on('error', () => { clearTimeout(timeout); resolve(cache.rates); });
  });
}

/**
 * 특정 종목의 펀딩비 시그널
 * @param {string} upbitSymbol - 'BTC/KRW'
 * @param {Object} rates - fetchFundingRates() 결과
 * @returns {{ rate, signal, buyBoost, sellBoost }}
 */
function getFundingSignal(upbitSymbol, rates) {
  const binSym = toBindanceSymbol(upbitSymbol);
  const rate = rates[binSym];

  if (rate == null) return { rate: null, signal: 'none', buyBoost: 0, sellBoost: 0 };

  const pct = rate * 100; // 0.0001 → 0.01%

  let signal = 'neutral';
  let buyBoost = 0;
  let sellBoost = 0;

  // 극단적 양수: 롱 과잉 → 하락 경고
  if (pct >= 0.1) {
    signal = 'extreme_long';
    sellBoost = 1.5;
    buyBoost = -1.0; // 매수 강력 감점
  } else if (pct >= 0.05) {
    signal = 'long_heavy';
    sellBoost = 0.8;
    buyBoost = -0.5;
  } else if (pct >= 0.03) {
    signal = 'slight_long';
    sellBoost = 0.3;
  }

  // 음수: 숏 과잉 → 숏스퀴즈 가능성
  if (pct <= -0.05) {
    signal = 'extreme_short';
    buyBoost = 1.5;
    sellBoost = -0.5; // 매도 감점
  } else if (pct <= -0.02) {
    signal = 'short_heavy';
    buyBoost = 0.8;
  } else if (pct <= -0.01) {
    signal = 'slight_short';
    buyBoost = 0.3;
  }

  return {
    rate: Math.round(pct * 10000) / 10000,
    signal,
    buyBoost: Math.round(buyBoost * 100) / 100,
    sellBoost: Math.round(sellBoost * 100) / 100,
  };
}

/**
 * BTC 펀딩비 종합 시그널 (전체 시장 분위기)
 * @param {Object} rates - fetchFundingRates() 결과
 * @returns {{ btcRate, avgRate, signal, marketBuyBoost, marketSellBoost }}
 */
function getMarketFundingSignal(rates) {
  const btcRate = rates['BTCUSDT'];
  const ethRate = rates['ETHUSDT'];

  if (btcRate == null) return { btcRate: null, avgRate: null, signal: 'none', marketBuyBoost: 0, marketSellBoost: 0 };

  const avg = ethRate != null ? (btcRate + ethRate) / 2 : btcRate;
  const pct = avg * 100;

  let signal = 'neutral';
  let marketBuyBoost = 0;
  let marketSellBoost = 0;

  if (pct >= 0.08) {
    signal = 'market_overleveraged';
    marketSellBoost = 1.0;
    marketBuyBoost = -0.5;
  } else if (pct <= -0.03) {
    signal = 'market_squeezable';
    marketBuyBoost = 1.0;
  }

  return {
    btcRate: Math.round(btcRate * 10000) / 10000,
    avgRate: Math.round(avg * 10000) / 10000,
    signal,
    marketBuyBoost: Math.round(marketBuyBoost * 100) / 100,
    marketSellBoost: Math.round(marketSellBoost * 100) / 100,
  };
}

module.exports = { fetchFundingRates, getFundingSignal, getMarketFundingSignal };
