/**
 * 김프 (Korea Premium Index) 모니터링
 *
 * 업비트 KRW 가격 vs 바이낸스 USDT 가격 비교
 * 김프가 높으면 → 과열 → 매수 자제
 * 김프가 급락하면 → 공포 → 매수 기회
 *
 * 환율은 간단한 API로 가져오거나 하드코딩 (1 USDT ≈ 1380원 근사)
 */

const https = require('https');

const CACHE_TTL = 300000; // 5분 캐시
let cachedResult = null;
let lastFetchTime = 0;

// 환율 캐시
let cachedExRate = 1380; // 기본값
let lastExRateFetch = 0;

/**
 * 바이낸스 USDT 가격 조회 (공개 API, 키 불필요)
 */
function fetchBinancePrice(symbol) {
  const pair = symbol.replace('/KRW', 'USDT'); // BTC/KRW → BTCUSDT
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(parseFloat(json.price));
        } catch { reject(new Error('parse error')); }
      });
    }).on('error', reject);
  });
}

/**
 * 바이낸스 여러 종목 가격 한번에 조회
 */
function fetchBinancePrices() {
  return new Promise((resolve, reject) => {
    const url = 'https://api.binance.com/api/v3/ticker/price';
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const prices = {};
          const arr = JSON.parse(data);
          for (const item of arr) {
            if (item.symbol.endsWith('USDT')) {
              const base = item.symbol.replace('USDT', '');
              prices[base] = parseFloat(item.price);
            }
          }
          resolve(prices);
        } catch { reject(new Error('parse error')); }
      });
    }).on('error', reject);
  });
}

/**
 * 환율 조회 (간단한 방법)
 */
async function fetchExchangeRate() {
  if (Date.now() - lastExRateFetch < 3600000) return cachedExRate; // 1시간 캐시

  try {
    const rate = await new Promise((resolve, reject) => {
      // 무료 환율 API
      https.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.rates?.KRW || 1380);
          } catch { resolve(1380); }
        });
      }).on('error', () => resolve(1380));
    });
    cachedExRate = rate;
    lastExRateFetch = Date.now();
    return rate;
  } catch {
    return cachedExRate;
  }
}

/**
 * 김프 계산
 * @param {Object} upbitPrices - { 'BTC/KRW': 102000000, 'ETH/KRW': 3500000, ... }
 * @returns {{ overall, bySymbol, signal, buyBoost, sellBoost }}
 */
async function calculateKimchiPremium(upbitPrices) {
  if (cachedResult && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedResult;
  }

  try {
    const [binancePrices, exRate] = await Promise.all([
      fetchBinancePrices(),
      fetchExchangeRate(),
    ]);

    const bySymbol = {};
    let totalPremium = 0;
    let count = 0;

    for (const [symbol, krwPrice] of Object.entries(upbitPrices)) {
      const base = symbol.replace('/KRW', '');
      const usdtPrice = binancePrices[base];
      if (!usdtPrice || krwPrice <= 0) continue;

      const fairKRW = usdtPrice * exRate;
      const premium = ((krwPrice - fairKRW) / fairKRW) * 100;

      bySymbol[symbol] = {
        upbitKRW: Math.round(krwPrice),
        binanceUSDT: usdtPrice,
        fairKRW: Math.round(fairKRW),
        premium: Math.round(premium * 100) / 100,
      };

      totalPremium += premium;
      count++;
    }

    const avgPremium = count > 0 ? Math.round((totalPremium / count) * 100) / 100 : 0;

    // 시그널 판단
    let signal = 'neutral';
    let buyBoost = 0;
    let sellBoost = 0;

    if (avgPremium > 5) {
      signal = 'extreme_premium'; // 극단적 김프 → 매수 자제
      sellBoost = 1.0;
    } else if (avgPremium > 3) {
      signal = 'high_premium'; // 높은 김프 → 주의
      sellBoost = 0.5;
    } else if (avgPremium > 1) {
      signal = 'mild_premium'; // 소폭 김프 → 보통
    } else if (avgPremium > -1) {
      signal = 'neutral'; // 김프 없음 → 정상
    } else if (avgPremium > -3) {
      signal = 'discount'; // 역프 → 매수 기회
      buyBoost = 0.5;
    } else {
      signal = 'deep_discount'; // 심한 역프 → 강한 매수 기회
      buyBoost = 1.0;
    }

    const result = {
      avgPremium,
      bySymbol,
      exRate: Math.round(exRate),
      signal,
      buyBoost,
      sellBoost,
      count,
      fetchedAt: Date.now(),
    };

    cachedResult = result;
    lastFetchTime = Date.now();

    return result;
  } catch (error) {
    // 실패 시 캐시 반환 또는 기본값
    return cachedResult || {
      avgPremium: 0,
      bySymbol: {},
      exRate: cachedExRate,
      signal: 'unknown',
      buyBoost: 0,
      sellBoost: 0,
      count: 0,
      error: error.message,
    };
  }
}

module.exports = { calculateKimchiPremium, fetchBinancePrice };
