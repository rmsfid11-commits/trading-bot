require('dotenv').config();

const { TradingBot } = require('./src/bot/TradingBot');
const { UpbitExchange } = require('./src/exchanges/upbit');
const { PaperExchange } = require('./src/exchanges/paper');
const { DashboardServer } = require('./src/dashboard/server');
const { Notifier } = require('./src/notifications/notifier');
const { logger } = require('./src/logger/trade-logger');

const TAG = 'MAIN';
const PAPER_MODE = process.env.PAPER_TRADE === 'true';

async function main() {
  logger.info(TAG, '========================================');
  logger.info(TAG, `  자동매매 봇 v2.0 ${PAPER_MODE ? '📝 [페이퍼 트레이딩]' : ''}`);
  logger.info(TAG, '  거래소: Upbit (KRW 마켓)');
  logger.info(TAG, '========================================');

  // 환경변수 확인
  if (!process.env.UPBIT_ACCESS_KEY || !process.env.UPBIT_SECRET_KEY) {
    logger.error(TAG, '.env 파일에 UPBIT_ACCESS_KEY, UPBIT_SECRET_KEY를 설정하세요.');
    logger.info(TAG, '.env.example 파일을 참고하세요.');
    process.exit(1);
  }

  const realExchange = new UpbitExchange();
  const exchange = PAPER_MODE
    ? new PaperExchange(realExchange, parseInt(process.env.PAPER_BALANCE || '1000000'))
    : realExchange;
  const bot = new TradingBot(exchange);
  bot.notifier = new Notifier();

  // 대시보드 서버
  const dashboard = new DashboardServer(bot);
  dashboard.start();

  // 종료 시그널 처리
  const shutdown = async (signal) => {
    logger.warn(TAG, `${signal} 수신 — 안전 종료 시작...`);
    dashboard.stop();
    await bot.stop();
    logger.info(TAG, '프로세스 종료');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error(TAG, `예기치 않은 에러: ${err.message}`);
    logger.error(TAG, err.stack);
    // 포트 충돌 등 시작 에러는 포지션 청산 없이 종료
    if (err.code === 'EADDRINUSE' || !bot.running) {
      logger.warn(TAG, '시작 에러 — 포지션 유지한 채 종료');
      process.exit(1);
    }
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(TAG, `처리되지 않은 Promise 거부: ${reason}`);
  });

  // 봇 시작
  await bot.start();
}

main().catch((err) => {
  logger.error(TAG, `시작 실패: ${err.message}`);
  process.exit(1);
});
