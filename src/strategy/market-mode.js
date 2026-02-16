/**
 * 마켓 모드 시스템 (Market Mode)
 *
 * 레짐 + F&G + BTC 추세를 종합하여 3가지 모드 자동 전환:
 * - aggressive (공격): 상승장 — 적극 매수, 넓은 익절, 큰 포지션
 * - defensive (방어): 하락장/공포 — 보수적, 좁은 익절, 작은 포지션
 * - scalping (스캘핑): 횡보장 — 빠른 회전, 좁은 목표
 */

const https = require('https');

// BTC 도미넌스 캐시
let btcDomCache = { value: null, trend: 'stable', lastUpdate: 0 };
const BTC_DOM_INTERVAL = 600000; // 10분

/**
 * BTC 도미넌스 조회 (CoinGecko 무료 API)
 */
function fetchBTCDominance() {
  if (Date.now() - btcDomCache.lastUpdate < BTC_DOM_INTERVAL && btcDomCache.value !== null) {
    return Promise.resolve(btcDomCache);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(btcDomCache), 5000);

    https.get('https://api.coingecko.com/api/v3/global', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          const newDom = json.data?.market_cap_percentage?.btc;
          if (newDom != null) {
            const prev = btcDomCache.value;
            btcDomCache = {
              value: Math.round(newDom * 100) / 100,
              trend: prev != null
                ? (newDom > prev + 0.5 ? 'rising' : newDom < prev - 0.5 ? 'falling' : 'stable')
                : 'stable',
              lastUpdate: Date.now(),
            };
          }
          resolve(btcDomCache);
        } catch { resolve(btcDomCache); }
      });
    }).on('error', () => { clearTimeout(timeout); resolve(btcDomCache); });
  });
}

/**
 * 마켓 모드 결정
 * @param {string} regime - 'trending' | 'ranging' | 'volatile'
 * @param {number} fgValue - Fear & Greed (0-100)
 * @param {Object} btcSignal - { momentum, buyBoost, sellBoost }
 * @param {Object} btcDominance - { value, trend }
 * @param {Object} regimeIndicators - { trendDirection, adx, atrPct }
 * @returns {{ mode, profile, reasons, score, btcDominance }}
 */
function determineMarketMode(regime, fgValue, btcSignal, btcDominance, regimeIndicators = {}) {
  const reasons = [];
  let score = 0; // + = aggressive, - = defensive, ~0 = scalping

  // 1. F&G 지수 (가장 큰 영향)
  if (fgValue >= 60) { score += 3; reasons.push(`F&G ${fgValue} (탐욕)`); }
  else if (fgValue >= 45) { score += 1; reasons.push(`F&G ${fgValue} (중립+)`); }
  else if (fgValue <= 15) { score -= 4; reasons.push(`F&G ${fgValue} (극단 공포)`); }
  else if (fgValue <= 25) { score -= 2; reasons.push(`F&G ${fgValue} (공포)`); }
  else { reasons.push(`F&G ${fgValue} (중립)`); }

  // 2. 레짐
  if (regime === 'volatile') {
    score -= 2;
    reasons.push('급변장');
  } else if (regime === 'trending') {
    const dir = regimeIndicators.trendDirection || 'flat';
    if (dir === 'up') { score += 2; reasons.push('상승 추세'); }
    else if (dir === 'down') { score -= 2; reasons.push('하락 추세'); }
  } else if (regime === 'ranging') {
    reasons.push('횡보장');
  }

  // 3. BTC 모멘텀
  const mom = btcSignal?.momentum || 0;
  if (mom > 1) { score += 1; reasons.push(`BTC +${mom}%`); }
  else if (mom < -1) { score -= 1; reasons.push(`BTC ${mom}%`); }

  // 4. BTC 도미넌스 (알트 영향)
  if (btcDominance?.value) {
    if (btcDominance.trend === 'rising' && btcDominance.value > 55) {
      score -= 0.5;
      reasons.push(`BTC.D ${btcDominance.value}%↑ (알트 약세)`);
    } else if (btcDominance.trend === 'falling' && btcDominance.value < 50) {
      score += 0.5;
      reasons.push(`BTC.D ${btcDominance.value}%↓ (알트 시즌)`);
    } else {
      reasons.push(`BTC.D ${btcDominance.value}%`);
    }
  }

  // 모드 결정
  let mode, profile;
  if (score >= 3) { mode = 'aggressive'; profile = PROFILES.aggressive; }
  else if (score <= -2) { mode = 'defensive'; profile = PROFILES.defensive; }
  else { mode = 'scalping'; profile = PROFILES.scalping; }

  return { mode, profile, reasons, score: Math.round(score * 10) / 10, btcDominance };
}

// ─── 모드별 전략 프로필 ───

const PROFILES = {
  aggressive: {
    label: '🟢 공격 모드',
    buyThresholdMult: 0.85,       // 매수 기준 15% 낮춤
    maxPositions: 4,               // 포지션 4개
    positionSizeMult: 1.2,         // 포지션 크기 +20%
    stopLossPct: -2.5,             // 손절 넓게
    takeProfitPct: 7,              // 익절 넓게
    maxHoldMult: 1.5,              // 보유시간 50% 연장
    trailingDistanceMult: 1.3,     // 트레일링 넓게
    hourlyMaxTrades: 5,
    dcaEnabled: true,
  },
  defensive: {
    label: '🔴 방어 모드',
    buyThresholdMult: 1.5,         // 매수 기준 50% 높임
    maxPositions: 2,               // 포지션 2개로 제한
    positionSizeMult: 0.6,         // 포지션 크기 40% 축소
    stopLossPct: -1.5,             // 손절 타이트
    takeProfitPct: 3,              // 익절 빠르게
    maxHoldMult: 0.6,              // 보유시간 짧게
    trailingDistanceMult: 0.8,     // 트레일링 좁게
    hourlyMaxTrades: 2,
    dcaEnabled: false,             // DCA 비활성화
  },
  scalping: {
    label: '🟡 스캘핑 모드',
    buyThresholdMult: 1.0,         // 기본
    maxPositions: 3,               // 기본
    positionSizeMult: 0.85,        // 약간 작게
    stopLossPct: -1.5,             // 손절 타이트
    takeProfitPct: 3,              // 익절 빠르게
    maxHoldMult: 0.5,              // 보유시간 짧게
    trailingDistanceMult: 0.7,     // 트레일링 좁게
    hourlyMaxTrades: 4,
    dcaEnabled: false,
  },
};

module.exports = { determineMarketMode, fetchBTCDominance, PROFILES };
