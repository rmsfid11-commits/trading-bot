const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { DEBUG: 0, INFO: 1, TRADE: 2, WARN: 3, ERROR: 4 };
let currentLevel = LEVELS.INFO;

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeToFile(msg) {
  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(LOG_DIR, `${date}.log`);
  fs.appendFileSync(filePath, msg + '\n');
}

function log(level, tag, message, data = null) {
  if (LEVELS[level] < currentLevel) return;

  const colors = { DEBUG: '\x1b[90m', INFO: '\x1b[36m', TRADE: '\x1b[33m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
  const reset = '\x1b[0m';

  const time = formatTime();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  const plain = `[${time}] [${level}] [${tag}] ${message}${dataStr}`;
  const colored = `${colors[level]}[${time}] [${level}]${reset} [${tag}] ${message}${dataStr}`;

  process.stdout.write(colored + '\n');
  writeToFile(plain);
}

const logger = {
  debug: (tag, msg, data) => log('DEBUG', tag, msg, data),
  info: (tag, msg, data) => log('INFO', tag, msg, data),
  trade: (tag, msg, data) => log('TRADE', tag, msg, data),
  warn: (tag, msg, data) => log('WARN', tag, msg, data),
  error: (tag, msg, data) => log('ERROR', tag, msg, data),
  setLevel: (level) => { currentLevel = LEVELS[level] || LEVELS.INFO; },

  logTrade(trade) {
    const { symbol, action, price, quantity, reason, pnl } = trade;
    const msg = `${action} ${symbol} @ ${price.toLocaleString()} x ${quantity}${pnl != null ? ` PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%` : ''} | ${reason}`;
    log('TRADE', 'EXEC', msg, trade);

    const tradePath = path.join(LOG_DIR, 'trades.jsonl');
    fs.appendFileSync(tradePath, JSON.stringify({ timestamp: Date.now(), ...trade }) + '\n');
  },
};

module.exports = { logger };
