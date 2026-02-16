require('dotenv').config();

const ccxt = require('ccxt');
const { BacktestEngine } = require('./src/backtest/engine');
const { BacktestReporter } = require('./src/backtest/reporter');

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const strategy = getArg('strategy', 'combo');
const symbol = getArg('symbol', 'BTC/KRW');
const range = getArg('range', '30d');
const capital = parseInt(getArg('capital', '1000000'), 10);
const format = getArg('format', 'console');

function parseRange(rangeStr) {
  const match = rangeStr.match(/^(\d+)(d|h|w)$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'h': return num * 3600000;
    case 'd': return num * 86400000;
    case 'w': return num * 7 * 86400000;
    default: return num * 86400000;
  }
}

async function fetchCandles(sym, rangeMs) {
  const exchange = new ccxt.upbit({ enableRateLimit: true });
  await exchange.loadMarkets();

  const timeframe = '5m';
  const now = Date.now();
  const since = now - rangeMs;
  const allCandles = [];
  let fetchSince = since;
  const limit = 200;

  console.log(`\n  업비트에서 ${sym} 캔들 데이터 수집 중...`);

  while (fetchSince < now) {
    try {
      const ohlcv = await exchange.fetchOHLCV(sym, timeframe, fetchSince, limit);
      if (!ohlcv || ohlcv.length === 0) break;

      for (const [timestamp, open, high, low, close, volume] of ohlcv) {
        allCandles.push({ timestamp, open, high, low, close, volume });
      }

      fetchSince = ohlcv[ohlcv.length - 1][0] + 1;
      process.stdout.write(`  수집: ${allCandles.length}개 캔들\r`);

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`  데이터 수집 에러: ${e.message}`);
      break;
    }
  }

  console.log(`  총 ${allCandles.length}개 캔들 수집 완료\n`);
  return allCandles;
}

async function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       트레이딩 봇 백테스터 v1.0      ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  전략: ${strategy} | 종목: ${symbol} | 기간: ${range} | 자본: ${capital.toLocaleString()}원`);

  const rangeMs = parseRange(range);
  const candles = await fetchCandles(symbol, rangeMs);

  if (candles.length < 50) {
    console.error('  데이터 부족: 최소 50개 캔들이 필요합니다.');
    process.exit(1);
  }

  const engine = new BacktestEngine({
    strategy,
    initialCapital: capital,
  });

  console.log('  백테스트 실행 중...');
  const result = engine.run(candles, symbol);

  if (format === 'json') {
    console.log(JSON.stringify(BacktestReporter.formatJSON(result), null, 2));
  } else {
    console.log(BacktestReporter.formatConsole(result));
    console.log(BacktestReporter.formatMonthly(result));
  }
}

main().catch(e => {
  console.error(`  실행 에러: ${e.message}`);
  process.exit(1);
});
