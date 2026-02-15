const fs = require('fs');
const path = require('path');

const LEARNED_PATH = path.join(__dirname, '../../logs/learned-params.json');

const DEFAULT_STRATEGY = {
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 32,       // 40→32: 허위 신호 감소
  RSI_OVERBOUGHT: 72,     // 70→72: 약간 여유

  BOLLINGER_PERIOD: 20,
  BOLLINGER_STD_DEV: 2,

  VOLUME_THRESHOLD: 1.5,

  STOP_LOSS_PCT: -1.5,
  TAKE_PROFIT_PCT: 5,       // 2.5→5: 분할매도로 중간 수익 확보, 최종 익절 여유
  MAX_HOLD_HOURS: 4,
  HARD_MAX_HOLD_HOURS: 8,   // 절대 최대 보유시간 (강제 종료)

  // 브레이크이븐 + 트레일링
  BREAKEVEN_TRIGGER_PCT: 1.5,   // +1.5% 도달 시 손절선을 진입가로 이동
  TRAILING_ACTIVATE_PCT: 2.5,   // +2.5% 도달 후부터 트레일링 스탑 활성화
  TRAILING_DISTANCE_PCT: 1.2,   // 최고가 대비 -1.2% 하락 시 매도

  // 분할매도 단계
  PARTIAL_1_PCT: 2.0,   // +2% → 40% 매도
  PARTIAL_1_FRAC: 0.4,
  PARTIAL_2_PCT: 4.0,   // +4% → 40% 추가 매도
  PARTIAL_2_FRAC: 0.4,
  // 나머지 20%는 트레일링으로 최대한 먹기

  COOLDOWN_MS: 900000,     // 매도 후 쿨다운: 15분 (기존 3분)

  MAX_POSITIONS: 3,        // 5→3: 과도한 노출 방지
  BASE_POSITION_PCT: 12,   // 18%→12%: 포지션 사이즈 축소

  // 휩쏘 방지
  STOP_CONFIRM_COUNT: 3,       // 손절선 3회 연속 터치 후 매도 (휩쏘 필터)
  HARD_DROP_PCT: -3,           // -3% 이하 급락은 즉시 매도

  // 리스크 관리
  DAILY_LOSS_LIMIT: -10000,    // 일일 손실 한도 (원)
  HOURLY_MAX_TRADES: 3,        // 시간당 최대 매수 횟수
  RECOVERY_COOLDOWN_MS: 1800000, // 일일한도 근접(-80%) 시 30분 쿨다운

  CANDLE_INTERVAL: 'minutes/5',
  CANDLE_COUNT: 200,
  SCAN_INTERVAL_MS: 10000,
};

// 학습 가능한 파라미터 목록
const LEARNABLE_KEYS = ['RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'STOP_LOSS_PCT', 'TAKE_PROFIT_PCT', 'MAX_HOLD_HOURS', 'BASE_POSITION_PCT'];

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
