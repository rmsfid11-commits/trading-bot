/**
 * 멀티유저 런처
 *
 * users/ 폴더의 .env 파일을 스캔하여 각 유저별 독립 봇 인스턴스 생성
 * 하나의 프로세스에서 모든 유저의 봇을 관리
 * 등록 페이지에서 새 유저 추가 시 자동으로 봇 시작
 *
 * 사용법: node multi-launcher.js
 * PM2:   pm2 start ecosystem.config.js --only trading-bot-multi
 */

// 루트 .env 로드 (ANTHROPIC_API_KEY 등 공통 환경변수)
require('dotenv').config();

const { getAllUserConfigs, getUserConfig } = require('./src/config/users');
const { TradingBot } = require('./src/bot/TradingBot');
const { UpbitExchange } = require('./src/exchanges/upbit');
const { PaperExchange } = require('./src/exchanges/paper');
const { DashboardServer } = require('./src/dashboard/server');
const { Notifier } = require('./src/notifications/notifier');
const { createLogger } = require('./src/logger/trade-logger');
const { logger: defaultLogger } = require('./src/logger/trade-logger');

const TAG = 'MULTI';

const instances = []; // { userId, bot, dashboard, logger }

/**
 * 유저 한 명의 봇 인스턴스 생성 + 시작
 */
function startUserBot(config) {
  // 이미 실행 중인지 체크
  if (instances.find(i => i.userId === config.userId)) {
    defaultLogger.warn(TAG, `${config.userId} 이미 실행 중 → 스킵`);
    return null;
  }

  const userLogger = createLogger(config.logDir, config.userId);
  userLogger.info(TAG, `${config.userId} 봇 초기화 중... (포트: ${config.port})`);

  // 거래소 인스턴스 (유저별 API 키)
  const credentials = { accessKey: config.accessKey, secretKey: config.secretKey };
  const realExchange = new UpbitExchange(credentials);
  const exchange = config.paperMode
    ? new PaperExchange(realExchange, config.paperBalance)
    : realExchange;

  // 봇 인스턴스 (유저별 logDir + 텔레그램 설정)
  const bot = new TradingBot(exchange, {
    userId: config.userId,
    logDir: config.logDir,
    telegramConfig: config.telegram,
  });

  // 알림
  bot.notifier = new Notifier();

  // 대시보드 (유저별 포트) + 등록 콜백
  const dashboard = new DashboardServer(bot, config.port, {
    logDir: config.logDir,
    onUserRegistered: handleNewUser,
  });
  dashboard.start();

  // 봇 시작 (비동기)
  bot.start().catch(err => {
    userLogger.error(TAG, `${config.userId} 봇 시작 실패: ${err.message}`);
  });

  const inst = { userId: config.userId, bot, dashboard, logger: userLogger };
  instances.push(inst);

  defaultLogger.info(TAG, `${config.userId} 봇 시작 완료 → 대시보드 :${config.port}`);
  return inst;
}

/**
 * 등록 페이지에서 새 유저 추가 시 호출되는 콜백
 */
function handleNewUser(userId) {
  try {
    defaultLogger.info(TAG, `새 유저 등록 감지: ${userId} → 봇 자동 시작`);
    const config = getUserConfig(userId);
    startUserBot(config);
  } catch (err) {
    defaultLogger.error(TAG, `${userId} 자동 시작 실패: ${err.message}`);
  }
}

async function main() {
  defaultLogger.info(TAG, '========================================');
  defaultLogger.info(TAG, '  멀티유저 자동매매 봇 런처');
  defaultLogger.info(TAG, '========================================');

  const configs = getAllUserConfigs();

  if (configs.length === 0) {
    defaultLogger.error(TAG, 'users/ 폴더에 .env 파일이 없습니다.');
    defaultLogger.info(TAG, 'users/user1.env 파일을 생성하세요. (users/example.env 참고)');
    process.exit(1);
  }

  defaultLogger.info(TAG, `${configs.length}명의 유저 설정 로드 완료`);

  for (const config of configs) {
    try {
      startUserBot(config);
    } catch (err) {
      defaultLogger.error(TAG, `${config.userId} 초기화 실패: ${err.message}`);
    }
  }

  if (instances.length === 0) {
    defaultLogger.error(TAG, '시작된 봇이 없습니다.');
    process.exit(1);
  }

  defaultLogger.info(TAG, `총 ${instances.length}개 봇 실행 중`);

  // 종료 시그널 처리
  const shutdown = async (signal) => {
    defaultLogger.warn(TAG, `${signal} 수신 — 전체 안전 종료 시작...`);

    for (const inst of instances) {
      try {
        inst.dashboard.stop();
        await inst.bot.stop();
        defaultLogger.info(TAG, `${inst.userId} 종료 완료`);
      } catch (err) {
        defaultLogger.error(TAG, `${inst.userId} 종료 실패: ${err.message}`);
      }
    }

    defaultLogger.info(TAG, '전체 프로세스 종료');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    defaultLogger.error(TAG, `예기치 않은 에러: ${err.message}`);
    defaultLogger.error(TAG, err.stack);
    if (err.code === 'EADDRINUSE') {
      defaultLogger.warn(TAG, '포트 충돌 — 포지션 유지한 채 종료');
      process.exit(1);
    }
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    defaultLogger.error(TAG, `처리되지 않은 Promise 거부: ${reason}`);
  });
}

main().catch((err) => {
  defaultLogger.error(TAG, `런처 시작 실패: ${err.message}`);
  process.exit(1);
});
