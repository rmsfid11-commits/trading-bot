/**
 * Whale Alert Integration
 *
 * Large crypto transactions from whale-alert.io
 * Exchange inflow = bearish (selling pressure)
 * Exchange outflow = bullish (accumulation)
 *
 * Gracefully degrades if API is unavailable
 * Caches results for 5 minutes to respect rate limits
 */

const https = require('https');
const { logger } = require('../logger/trade-logger');

const TAG = 'WHALE';

// Cache
let _whaleCache = null;
let _whaleCacheTime = 0;
const CACHE_TTL = 300000; // 5 minutes

// Known exchange wallets (partial list for identification)
const EXCHANGE_NAMES = [
  'binance', 'coinbase', 'kraken', 'bitfinex', 'huobi', 'okex', 'okx',
  'upbit', 'bithumb', 'bybit', 'kucoin', 'gate.io', 'bitstamp',
  'gemini', 'ftx', 'crypto.com', 'poloniex', 'bittrex', 'coinone',
];

/**
 * HTTP GET with timeout
 */
function _httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'TradingBot/2.0 (Node.js)',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON parse error'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Check if an address owner is a known exchange
 */
function _isExchange(ownerName) {
  if (!ownerName || ownerName === 'unknown') return false;
  const lower = ownerName.toLowerCase();
  return EXCHANGE_NAMES.some(ex => lower.includes(ex));
}

/**
 * Fetch whale alerts from whale-alert.io free API
 * Falls back to empty array on failure
 */
async function _fetchFromWhaleAlert() {
  try {
    // Free API: last 1 hour, min 500k USD
    const startTime = Math.floor((Date.now() - 3600000) / 1000);
    const url = `https://api.whale-alert.io/v1/transactions?api_key=free&min_value=500000&start=${startTime}`;
    const data = await _httpGet(url, 10000);

    if (!data || !data.transactions || !Array.isArray(data.transactions)) {
      return [];
    }

    return data.transactions.map(tx => ({
      coin: (tx.symbol || '').toUpperCase(),
      amount: tx.amount || 0,
      usdValue: tx.amount_usd || 0,
      from: tx.from?.owner_type || 'unknown',
      to: tx.to?.owner_type || 'unknown',
      fromOwner: tx.from?.owner || 'unknown',
      toOwner: tx.to?.owner || 'unknown',
      isExchangeInflow: _isExchange(tx.to?.owner) && !_isExchange(tx.from?.owner),
      isExchangeOutflow: _isExchange(tx.from?.owner) && !_isExchange(tx.to?.owner),
      hash: tx.hash || '',
      timestamp: (tx.timestamp || 0) * 1000,
    }));
  } catch (e) {
    // whale-alert free tier often fails; this is expected
    return null;
  }
}

/**
 * Fallback: Fetch from blockchain.info (BTC only, public API)
 * Gets recent large BTC transactions
 */
async function _fetchFromBlockchainInfo() {
  try {
    const url = 'https://blockchain.info/unconfirmed-transactions?format=json';
    const data = await _httpGet(url, 10000);

    if (!data || !data.txs) return [];

    // Filter for large transactions (> 10 BTC ~ roughly $500k+)
    const largeTxs = data.txs.filter(tx => {
      const totalOut = tx.out.reduce((sum, o) => sum + (o.value || 0), 0) / 1e8;
      return totalOut > 10;
    }).slice(0, 20); // Top 20

    return largeTxs.map(tx => {
      const totalBTC = tx.out.reduce((sum, o) => sum + (o.value || 0), 0) / 1e8;
      return {
        coin: 'BTC',
        amount: Math.round(totalBTC * 100) / 100,
        usdValue: 0, // blockchain.info doesn't give USD value
        from: 'unknown',
        to: 'unknown',
        fromOwner: 'unknown',
        toOwner: 'unknown',
        isExchangeInflow: false,
        isExchangeOutflow: false,
        hash: tx.hash || '',
        timestamp: (tx.time || 0) * 1000,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Fetch whale alerts (with caching)
 * Tries whale-alert.io first, falls back to blockchain.info
 * @returns {Promise<Array>} Array of whale transactions
 */
async function fetchWhaleAlerts() {
  const now = Date.now();

  // Return cached data if fresh
  if (_whaleCache && (now - _whaleCacheTime) < CACHE_TTL) {
    return _whaleCache;
  }

  let alerts = [];

  // Try whale-alert.io first
  const whaleData = await _fetchFromWhaleAlert();
  if (whaleData && whaleData.length > 0) {
    alerts = whaleData;
    logger.info(TAG, `Whale Alert API: ${alerts.length}건 수신`);
  } else {
    // Fallback to blockchain.info
    const btcData = await _fetchFromBlockchainInfo();
    if (btcData && btcData.length > 0) {
      alerts = btcData;
      logger.info(TAG, `Blockchain.info 폴백: ${alerts.length}건 대형 BTC 거래`);
    } else {
      logger.info(TAG, 'Whale alert 데이터 없음 (API 제한 또는 네트워크 오류)');
    }
  }

  // Sort by USD value descending
  alerts.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

  // Keep top 50
  alerts = alerts.slice(0, 50);

  _whaleCache = alerts;
  _whaleCacheTime = now;

  return alerts;
}

/**
 * Get whale signal for a specific symbol
 * Analyzes recent whale activity for buy/sell pressure
 *
 * @param {string} symbol - e.g. 'BTC/KRW'
 * @returns {{ buyBoost: number, sellBoost: number, summary: string }}
 */
function getWhaleSignal(symbol) {
  if (!_whaleCache || _whaleCache.length === 0) {
    return { buyBoost: 0, sellBoost: 0, summary: 'no data' };
  }

  // Extract coin name from symbol (e.g. 'BTC/KRW' -> 'BTC')
  const coin = symbol.split('/')[0].toUpperCase();

  // Filter transactions for this coin (last 1 hour)
  const oneHourAgo = Date.now() - 3600000;
  const coinTxs = _whaleCache.filter(tx =>
    tx.coin === coin && tx.timestamp > oneHourAgo
  );

  if (coinTxs.length === 0) {
    return { buyBoost: 0, sellBoost: 0, summary: 'no activity' };
  }

  let inflowUsd = 0;  // Exchange inflows (bearish)
  let outflowUsd = 0;  // Exchange outflows (bullish)

  for (const tx of coinTxs) {
    const val = tx.usdValue || 0;
    if (tx.isExchangeInflow) inflowUsd += val;
    if (tx.isExchangeOutflow) outflowUsd += val;
  }

  // Threshold: $5M+ for significant signal
  const SIGNIFICANT_THRESHOLD = 5000000;

  let buyBoost = 0;
  let sellBoost = 0;
  let summary = '';

  if (outflowUsd > SIGNIFICANT_THRESHOLD && outflowUsd > inflowUsd * 2) {
    // Large outflows dominate = bullish (coins leaving exchanges)
    buyBoost = Math.min(0.5, outflowUsd / 50000000); // Max 0.5 boost at $50M+
    summary = `outflow $${(outflowUsd / 1e6).toFixed(1)}M (bullish)`;
  } else if (inflowUsd > SIGNIFICANT_THRESHOLD && inflowUsd > outflowUsd * 2) {
    // Large inflows dominate = bearish (coins entering exchanges to sell)
    sellBoost = Math.min(0.5, inflowUsd / 50000000);
    summary = `inflow $${(inflowUsd / 1e6).toFixed(1)}M (bearish)`;
  } else {
    summary = `balanced (in: $${(inflowUsd / 1e6).toFixed(1)}M, out: $${(outflowUsd / 1e6).toFixed(1)}M)`;
  }

  return { buyBoost, sellBoost, summary };
}

/**
 * Get cached whale alerts (for dashboard display)
 * @returns {Array}
 */
function getCachedWhaleAlerts() {
  return _whaleCache || [];
}

module.exports = { fetchWhaleAlerts, getWhaleSignal, getCachedWhaleAlerts };
