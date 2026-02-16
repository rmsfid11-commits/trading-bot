/**
 * 멀티유저 설정 로더
 *
 * users/ 폴더의 *.env 파일을 읽어서 유저 목록과 설정 반환
 * 파일명(확장자 제외)이 userId가 됨
 *
 * 예: users/user1.env → userId = 'user1'
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const USERS_DIR = path.join(__dirname, '../../users');
const LOGS_BASE = path.join(__dirname, '../../logs');

/**
 * users/ 폴더에서 모든 .env 파일을 찾아 userId 목록 반환
 * @returns {string[]} ['user1', 'user2', ...]
 */
function listUsers() {
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs.readdirSync(USERS_DIR)
    .filter(f => f.endsWith('.env') && f !== 'example.env')
    .map(f => f.replace('.env', ''))
    .sort();
}

/**
 * 특정 유저의 설정 로드
 * @param {string} userId
 * @returns {Object} { userId, accessKey, secretKey, port, logDir, telegram, discord, paperMode, paperBalance }
 */
function getUserConfig(userId) {
  const envPath = path.join(USERS_DIR, `${userId}.env`);
  if (!fs.existsSync(envPath)) {
    throw new Error(`유저 설정 파일 없음: ${envPath}`);
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));

  const accessKey = parsed.UPBIT_ACCESS_KEY;
  const secretKey = parsed.UPBIT_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error(`${userId}: UPBIT_ACCESS_KEY 또는 UPBIT_SECRET_KEY 누락`);
  }

  const port = parseInt(parsed.DASHBOARD_PORT) || 3737;
  const logDir = path.join(LOGS_BASE, userId);

  // 로그 디렉토리 생성
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return {
    userId,
    accessKey,
    secretKey,
    port,
    logDir,
    paperMode: parsed.PAPER_TRADE === 'true',
    paperBalance: parseInt(parsed.PAPER_BALANCE) || 1000000,
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN || '',
      chatId: parsed.TELEGRAM_CHAT_ID || '',
    },
    discord: {
      webhookUrl: parsed.DISCORD_WEBHOOK_URL || '',
    },
  };
}

/**
 * 모든 유저 설정 로드
 * @returns {Object[]}
 */
function getAllUserConfigs() {
  return listUsers().map(userId => {
    try {
      return getUserConfig(userId);
    } catch (e) {
      console.error(`[USERS] ${userId} 설정 로드 실패: ${e.message}`);
      return null;
    }
  }).filter(Boolean);
}

module.exports = { listUsers, getUserConfig, getAllUserConfigs, USERS_DIR, LOGS_BASE };
