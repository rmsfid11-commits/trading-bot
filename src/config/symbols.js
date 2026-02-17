const NASDAQ_SYMBOLS = ['TQQQ', 'SQQQ', 'QQQ', 'NVDA', 'TSLA', 'AMD', 'META', 'COIN'];

// 기본 종목 (API 조회 실패 시 폴백)
const DEFAULT_CRYPTO_SYMBOLS = [
  { symbol: 'BTC/KRW', market: 'KRW-BTC' },
  { symbol: 'ETH/KRW', market: 'KRW-ETH' },
  { symbol: 'XRP/KRW', market: 'KRW-XRP' },
  { symbol: 'SOL/KRW', market: 'KRW-SOL' },
  { symbol: 'DOGE/KRW', market: 'KRW-DOGE' },
  { symbol: 'ADA/KRW', market: 'KRW-ADA' },
  { symbol: 'AVAX/KRW', market: 'KRW-AVAX' },
  { symbol: 'DOT/KRW', market: 'KRW-DOT' },
  { symbol: 'MATIC/KRW', market: 'KRW-MATIC' },
  { symbol: 'LINK/KRW', market: 'KRW-LINK' },
];

// 업비트에서 KRW 마켓 거래량 상위 10종목 조회
async function fetchTopVolumeSymbols(count = 10) {
  try {
    const https = require('https');

    const markets = await new Promise((resolve, reject) => {
      https.get('https://api.upbit.com/v1/market/all?is_details=false', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      }).on('error', reject);
    });

    const krwMarkets = markets
      .filter(m => m.market.startsWith('KRW-'))
      .map(m => m.market);

    if (krwMarkets.length === 0) return DEFAULT_CRYPTO_SYMBOLS;

    const tickers = await new Promise((resolve, reject) => {
      const url = `https://api.upbit.com/v1/ticker?markets=${krwMarkets.join(',')}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // 소형 잡알트 필터: 최소 거래대금 50억원 + 최소 가격 10원
    const MIN_TRADE_VOLUME_KRW = 5_000_000_000; // 24h 거래대금 50억원
    const MIN_PRICE = 10; // 최소 가격 10원 (극저가 코인 제외)

    const filtered = tickers.filter(t =>
      t.acc_trade_price_24h >= MIN_TRADE_VOLUME_KRW &&
      t.trade_price >= MIN_PRICE
    );

    const sorted = filtered
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, count);

    return sorted.map(t => {
      const coin = t.market.replace('KRW-', '');
      return { symbol: `${coin}/KRW`, market: t.market };
    });
  } catch (error) {
    return DEFAULT_CRYPTO_SYMBOLS;
  }
}

module.exports = { NASDAQ_SYMBOLS, CRYPTO_SYMBOLS: DEFAULT_CRYPTO_SYMBOLS, fetchTopVolumeSymbols };
