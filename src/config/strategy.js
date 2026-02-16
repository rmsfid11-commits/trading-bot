const fs = require('fs');
const path = require('path');

const DEFAULT_LEARNED_PATH = path.join(__dirname, '../../logs/learned-params.json');

const DEFAULT_STRATEGY = {
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 32,       // 40→32: 허위 신호 감소
  RSI_OVERBOUGHT: 72,     // 70→72: 약간 여유

  BOLLINGER_PERIOD: 20,
  BOLLINGER_STD_DEV: 2,

  VOLUME_THRESHOLD: 1.5,

  STOP_LOSS_PCT: -2.5,        // -1.5→-2.5: 크립토 일상 변동 감안, 휩쏘 방지
  TAKE_PROFIT_PCT: 6,         // 5→6: 분할매도로 중간 수익 확보, 최종 익절 여유
  MAX_HOLD_HOURS: 6,          // 4→6: 충분한 추세 발전 시간 확보
  HARD_MAX_HOLD_HOURS: 12,    // 8→12: 강한 추세 유지 가능성

  // 브레이크이븐 + 트레일링
  BREAKEVEN_TRIGGER_PCT: 2.0,   // 1.5→2.0: 너무 빠른 본전 이동 방지
  TRAILING_ACTIVATE_PCT: 3.0,   // 2.5→3.0: 충분한 수익 후 트레일링
  TRAILING_DISTANCE_PCT: 1.5,   // 1.2→1.5: 트레일링 여유 확대

  // 분할매도 단계 (R:R 개선)
  PARTIAL_1_PCT: 3.0,   // +3% → 30% 매도 (기존: +2%/40%)
  PARTIAL_1_FRAC: 0.3,
  PARTIAL_2_PCT: 5.0,   // +5% → 30% 추가 매도 (기존: +4%/40%)
  PARTIAL_2_FRAC: 0.3,
  // 나머지 40%는 트레일링으로 최대한 먹기

  COOLDOWN_MS: 600000,     // 매도 후 쿨다운: 10분 (15분→10분: 기회 놓침 방지)

  MAX_POSITIONS: 4,        // 10→4: 15만원으로 4종목 집중
  BASE_POSITION_PCT: 22,   // 7%→22%: 종목당 22% 집중 투자

  // 휩쏘 방지 (강화)
  STOP_CONFIRM_COUNT: 3,            // 손절선 3회 터치 후 매도
  STOP_CONFIRM_MIN_INTERVAL: 60000, // 터치 간 최소 1분 간격
  STOP_CONFIRM_MIN_DURATION: 300000,// 첫 터치~매도 최소 5분
  HARD_DROP_PCT: -4,                // -3→-4: 급락 기준 완화
  RSI_OVERSOLD_PROTECTION: 20,      // RSI<20이면 손절 유예

  // 리스크 관리
  DAILY_LOSS_LIMIT: -10000,    // 일일 손실 한도 (원)
  HOURLY_MAX_TRADES: 4,        // 시간당 최대 매수 횟수 (6→4: 소액계좌 집중)
  RECOVERY_COOLDOWN_MS: 1800000, // 일일한도 근접(-80%) 시 30분 쿨다운

  // DCA 물타기
  DCA_ENABLED: true,
  DCA_TRIGGER_PCT: -1.5,      // 매수가 대비 -1.5% 하락 시 추가 매수
  DCA_MAX_COUNT: 2,            // 최대 2회 물타기
  DCA_MULTIPLIER: 1.0,         // 추가 매수 금액 = 최초 매수 금액 × 배수
  DCA_MIN_INTERVAL: 600000,    // 물타기 간 최소 10분 간격

  // 그리드 트레이딩
  GRID_ENABLED: true,
  GRID_LEVELS: 3,              // 상하 3단계
  GRID_SPACING_PCT: 0.8,       // 그리드 간격 0.8%
  GRID_AMOUNT_PCT: 5,          // 그리드 매수 금액 (잔고의 5%)
  GRID_MAX_SYMBOLS: 2,         // 최대 2종목에서 그리드 운영
  GRID_MIN_VOLUME: 1.0,        // 최소 거래량 배수
  GRID_REGIME_ONLY: true,      // ranging 레짐에서만 활성화

  CANDLE_INTERVAL: 'minutes/5',
  CANDLE_COUNT: 200,
  SCAN_INTERVAL_MS: 10000,
};

// 학습 가능한 파라미터 목록
const LEARNABLE_KEYS = ['RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'STOP_LOSS_PCT', 'TAKE_PROFIT_PCT', 'MAX_HOLD_HOURS', 'BASE_POSITION_PCT'];

function loadLearnedParams(logDir = null) {
  try {
    const learnedPath = logDir ? path.join(logDir, 'learned-params.json') : DEFAULT_LEARNED_PATH;
    if (!fs.existsSync(learnedPath)) return null;
    return JSON.parse(fs.readFileSync(learnedPath, 'utf-8'));
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
