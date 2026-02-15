/**
 * 컨텍스트 밴딧 (Contextual Bandit)
 *
 * 시장 상태(context)에 따라 최적 전략 파라미터(action)를 선택하고,
 * 거래 결과(reward)로 업데이트하는 간단한 강화학습.
 *
 * 룩업 테이블 방식: ML 라이브러리 불필요
 */

const fs = require('fs');
const path = require('path');

const BANDIT_PATH = path.join(__dirname, '../../logs/bandit-state.json');
const LEARNING_RATE = 0.08; // 학습률 (너무 빠르면 불안정, 느리면 적응 안됨)

// 컨텍스트 키: 시장 레짐 × 시간대 구간
function getContextKey(regime, hour) {
  const timeSlot = hour < 6 ? 'dawn' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return `${regime}_${timeSlot}`;
}

// 기본 파라미터 프로필들
const DEFAULT_PROFILES = {
  conservative: { RSI_OVERSOLD: 30, RSI_OVERBOUGHT: 75, STOP_LOSS_PCT: -1.5, TAKE_PROFIT_PCT: 3, MAX_HOLD_HOURS: 2 },
  moderate:     { RSI_OVERSOLD: 40, RSI_OVERBOUGHT: 70, STOP_LOSS_PCT: -2,   TAKE_PROFIT_PCT: 5, MAX_HOLD_HOURS: 4 },
  aggressive:   { RSI_OVERSOLD: 45, RSI_OVERBOUGHT: 65, STOP_LOSS_PCT: -3,   TAKE_PROFIT_PCT: 8, MAX_HOLD_HOURS: 6 },
};

const PROFILE_NAMES = Object.keys(DEFAULT_PROFILES);

class ContextualBandit {
  constructor() {
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(BANDIT_PATH)) {
        return JSON.parse(fs.readFileSync(BANDIT_PATH, 'utf-8'));
      }
    } catch { }
    return this._initState();
  }

  _initState() {
    const state = { contexts: {}, totalUpdates: 0 };
    // 모든 컨텍스트에 대해 동일 초기 가중치
    const regimes = ['trending', 'ranging', 'volatile', 'unknown'];
    const timeSlots = ['dawn', 'morning', 'afternoon', 'evening'];
    for (const r of regimes) {
      for (const t of timeSlots) {
        const key = `${r}_${t}`;
        state.contexts[key] = {
          weights: { conservative: 1.0, moderate: 1.0, aggressive: 1.0 },
          trials: { conservative: 0, moderate: 0, aggressive: 0 },
          totalReward: { conservative: 0, moderate: 0, aggressive: 0 },
        };
      }
    }
    return state;
  }

  _save() {
    try {
      const dir = path.dirname(BANDIT_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(BANDIT_PATH, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch { }
  }

  /**
   * 현재 컨텍스트에서 최적 전략 프로필 선택
   * epsilon-greedy: 10% 탐색, 90% 활용
   */
  selectProfile(regime, hour) {
    const key = getContextKey(regime, hour);
    const ctx = this.state.contexts[key];
    if (!ctx) return { profile: 'moderate', params: DEFAULT_PROFILES.moderate };

    // Epsilon-greedy
    const epsilon = Math.max(0.05, 0.2 - this.state.totalUpdates * 0.001); // 탐색률 감소
    if (Math.random() < epsilon) {
      const name = PROFILE_NAMES[Math.floor(Math.random() * PROFILE_NAMES.length)];
      return { profile: name, params: DEFAULT_PROFILES[name], explore: true };
    }

    // 가중치 기반 선택 (softmax)
    const weights = ctx.weights;
    const total = Object.values(weights).reduce((s, w) => s + Math.max(0.01, w), 0);
    let r = Math.random() * total;
    for (const name of PROFILE_NAMES) {
      r -= Math.max(0.01, weights[name]);
      if (r <= 0) {
        return { profile: name, params: DEFAULT_PROFILES[name], explore: false };
      }
    }
    return { profile: 'moderate', params: DEFAULT_PROFILES.moderate, explore: false };
  }

  /**
   * 거래 결과로 가중치 업데이트
   * @param {string} regime - 시장 레짐
   * @param {number} hour - 매수 시간
   * @param {string} profile - 사용한 프로필명
   * @param {number} reward - 수익률 (%)
   */
  update(regime, hour, profile, reward) {
    const key = getContextKey(regime, hour);
    if (!this.state.contexts[key]) return;

    const ctx = this.state.contexts[key];
    if (!ctx.weights[profile]) return;

    // 보상 정규화: -5%~+5% → -1~+1
    const normalizedReward = Math.max(-1, Math.min(1, reward / 5));

    // 가중치 업데이트
    ctx.weights[profile] += LEARNING_RATE * normalizedReward;
    ctx.weights[profile] = Math.max(0.01, Math.min(5, ctx.weights[profile])); // 바운드

    ctx.trials[profile] = (ctx.trials[profile] || 0) + 1;
    ctx.totalReward[profile] = (ctx.totalReward[profile] || 0) + reward;

    this.state.totalUpdates++;
    this._save();
  }

  /**
   * 현재 상태 요약
   */
  getSummary() {
    const summary = {};
    for (const [key, ctx] of Object.entries(this.state.contexts)) {
      const totalTrials = Object.values(ctx.trials).reduce((s, v) => s + v, 0);
      if (totalTrials === 0) continue;

      // 가장 높은 가중치 프로필
      const best = Object.entries(ctx.weights).sort((a, b) => b[1] - a[1])[0];
      summary[key] = {
        bestProfile: best[0],
        bestWeight: Math.round(best[1] * 100) / 100,
        totalTrials,
        avgRewards: {},
      };
      for (const p of PROFILE_NAMES) {
        if (ctx.trials[p] > 0) {
          summary[key].avgRewards[p] = Math.round(ctx.totalReward[p] / ctx.trials[p] * 100) / 100;
        }
      }
    }
    return summary;
  }
}

module.exports = { ContextualBandit, getContextKey, DEFAULT_PROFILES };
