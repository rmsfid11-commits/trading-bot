const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(DEFAULT_LOG_DIR)) fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });

const LEVELS = { DEBUG: 0, INFO: 1, TRADE: 2, WARN: 3, ERROR: 4 };
let currentLevel = LEVELS.INFO;

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function makeWriteToFile(logDir) {
  return function writeToFile(msg) {
    const date = new Date().toISOString().split('T')[0];
    const filePath = path.join(logDir, `${date}.log`);
    fs.appendFileSync(filePath, msg + '\n');
  };
}

function makeLog(writeToFile, prefix) {
  return function log(level, tag, message, data = null) {
    if (LEVELS[level] < currentLevel) return;

    const colors = { DEBUG: '\x1b[90m', INFO: '\x1b[36m', TRADE: '\x1b[33m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
    const reset = '\x1b[0m';

    const time = formatTime();
    const pfx = prefix ? `[${prefix}] ` : '';
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    const plain = `[${time}] [${level}] ${pfx}[${tag}] ${message}${dataStr}`;
    const colored = `${colors[level]}[${time}] [${level}]${reset} ${pfx}[${tag}] ${message}${dataStr}`;

    process.stdout.write(colored + '\n');
    writeToFile(plain);
  };
}

function makeLogTrade(logFn, logDir) {
  return function logTrade(trade) {
    const { symbol, action, price, quantity, reason, pnl } = trade;
    const msg = `${action} ${symbol} @ ${price.toLocaleString()} x ${quantity}${pnl != null ? ` PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%` : ''} | ${reason}`;
    logFn('TRADE', 'EXEC', msg, trade);

    const tradePath = path.join(logDir, 'trades.jsonl');
    fs.appendFileSync(tradePath, JSON.stringify({ timestamp: Date.now(), ...trade }) + '\n');
  };
}

/**
 * 유저별 독립 로거 생성
 * @param {string} logDir - 로그 디렉토리 경로
 * @param {string} [prefix] - 로그 접두사 (예: userId)
 * @returns {Object} logger 인스턴스
 */
function createLogger(logDir, prefix = '') {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const writeToFile = makeWriteToFile(logDir);
  const log = makeLog(writeToFile, prefix);

  const inst = {
    debug: (tag, msg, data) => log('DEBUG', tag, msg, data),
    info: (tag, msg, data) => log('INFO', tag, msg, data),
    trade: (tag, msg, data) => log('TRADE', tag, msg, data),
    warn: (tag, msg, data) => log('WARN', tag, msg, data),
    error: (tag, msg, data) => log('ERROR', tag, msg, data),
    setLevel: (level) => { currentLevel = LEVELS[level] || LEVELS.INFO; },
    logTrade: makeLogTrade(log, logDir),
  };

  return inst;
}

// 기본 로거 (하위 호환)
const defaultWriteToFile = makeWriteToFile(DEFAULT_LOG_DIR);
const defaultLog = makeLog(defaultWriteToFile, '');

const logger = {
  debug: (tag, msg, data) => defaultLog('DEBUG', tag, msg, data),
  info: (tag, msg, data) => defaultLog('INFO', tag, msg, data),
  trade: (tag, msg, data) => defaultLog('TRADE', tag, msg, data),
  warn: (tag, msg, data) => defaultLog('WARN', tag, msg, data),
  error: (tag, msg, data) => defaultLog('ERROR', tag, msg, data),
  setLevel: (level) => { currentLevel = LEVELS[level] || LEVELS.INFO; },
  logTrade: makeLogTrade(defaultLog, DEFAULT_LOG_DIR),
};

module.exports = { logger, createLogger };
