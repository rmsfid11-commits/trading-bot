const fs = require('fs');
const path = require('path');

const LEARNED_PATH = path.join(__dirname, '../../logs/learned-params.json');

const DEFAULT_STRATEGY = {
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 40,
  RSI_OVERBOUGHT: 70,

  BOLLINGER_PERIOD: 20,
  BOLLINGER_STD_DEV: 2,

  VOLUME_THRESHOLD: 1.5,

  STOP_LOSS_PCT: -2,
  TAKE_PROFIT_PCT: 5,
  MAX_HOLD_HOURS: 4,

  CANDLE_INTERVAL: 'minutes/5',
  CANDLE_COUNT: 200,
  SCAN_INTERVAL_MS: 10000,
};

// 학습 가능한 파라미터 목록
const LEARNABLE_KEYS = ['RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'STOP_LOSS_PCT', 'TAKE_PROFIT_PCT', 'MAX_HOLD_HOURS'];

function loadLearnedParams() {
  try {
    if (!fs.existsSync(LEARNED_PATH)) return null;
    return JSON.parse(fs.readFileSync(LEARNED_PATH, 'utf-8'));
  } catch { return null; }
}

function applyLearned(defaults, learned) {
  const strategy = { ...defaults };
  if (!learned?.params || learned.confidence < 0.5) return strategy;

  for (const key of LEARNABLE_KEYS) {
    if (learned.params[key] == null) continue;
    const defaultVal = defaults[key];
    const learnedVal = learned.params[key];

    // 변경 범위 제한: 기본값 대비 ±50%
    const absDefault = Math.abs(defaultVal);
    const maxDelta = absDefault * 0.5;
    const clamped = Math.max(defaultVal - maxDelta, Math.min(defaultVal + maxDelta, learnedVal));
    strategy[key] = Math.round(clamped * 100) / 100;
  }
  return strategy;
}

const learned = loadLearnedParams();
const STRATEGY = applyLearned(DEFAULT_STRATEGY, learned);

// 학습 적용 로그 (시작 시 출력)
if (learned?.params && learned.confidence >= 0.5) {
  const changes = [];
  for (const key of LEARNABLE_KEYS) {
    if (STRATEGY[key] !== DEFAULT_STRATEGY[key]) {
      changes.push(`${key}: ${DEFAULT_STRATEGY[key]} → ${STRATEGY[key]}`);
    }
  }
  if (changes.length > 0) {
    console.log(`[STRATEGY] 학습된 파라미터 적용 (신뢰도 ${(learned.confidence * 100).toFixed(0)}%): ${changes.join(', ')}`);
  }
}

module.exports = { STRATEGY, DEFAULT_STRATEGY, loadLearnedParams, applyLearned };
