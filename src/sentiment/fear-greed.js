/**
 * Crypto Fear & Greed Index
 *
 * alternative.me API 사용 (무료, API 키 불필요)
 * 0 = Extreme Fear (극도의 공포)
 * 100 = Extreme Greed (극도의 탐욕)
 *
 * 매매 적용:
 * - 극도의 공포(< 20): 역발상 매수 기회
 * - 공포(20~40): 매수 우호적
 * - 중립(40~60): 관망
 * - 탐욕(60~80): 매수 주의
 * - 극도의 탐욕(> 80): 매도 고려
 */

const https = require('https');
const { logger } = require('../logger/trade-logger');

const TAG = 'F&G';
const API_URL = 'https://api.alternative.me/fng/?limit=7&format=json';
const CACHE_TTL = 3600000; // 1시간

let cachedResult = null;
let lastFetchTime = 0;

/**
 * Fear & Greed Index 조회
 */
function fetchFearGreed() {
  return new Promise((resolve, reject) => {
    const req = https.get(API_URL, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Fear & Greed 분석
 * @returns {{ value, label, signal, trend, history }}
 */
async function analyzeFearGreed() {
  if (cachedResult && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedResult;
  }

  try {
    const data = await fetchFearGreed();
    const entries = data?.data || [];

    if (entries.length === 0) {
      throw new Error('No data');
    }

    const current = entries[0];
    const value = parseInt(current.value);
    const label = current.value_classification;

    // 추세 분석: 7일간 변화
    const history = entries.map(e => ({
      value: parseInt(e.value),
      label: e.value_classification,
      timestamp: parseInt(e.timestamp) * 1000,
    }));

    // 추세: 최근 vs 이전
    let trend = 'stable';
    if (history.length >= 3) {
      const recent = history.slice(0, 3).reduce((s, h) => s + h.value, 0) / 3;
      const older = history.length >= 6
        ? history.slice(3, 6).reduce((s, h) => s + h.value, 0) / Math.min(3, history.length - 3)
        : recent;
      if (recent > older + 5) trend = 'improving';
      else if (recent < older - 5) trend = 'worsening';
    }

    // 매매 시그널
    let signal, buyBoost;
    if (value <= 15) {
      signal = 'extreme_fear';
      buyBoost = 1.5;  // 극도의 공포 = 강한 매수 기회
    } else if (value <= 30) {
      signal = 'fear';
      buyBoost = 0.8;
    } else if (value <= 45) {
      signal = 'mild_fear';
      buyBoost = 0.3;
    } else if (value <= 55) {
      signal = 'neutral';
      buyBoost = 0;
    } else if (value <= 70) {
      signal = 'greed';
      buyBoost = -0.3; // 탐욕 = 매수 억제
    } else if (value <= 85) {
      signal = 'high_greed';
      buyBoost = -0.8;
    } else {
      signal = 'extreme_greed';
      buyBoost = -1.5; // 극도의 탐욕 = 강한 매도 압력
    }

    const result = {
      value,
      label,
      signal,
      buyBoost,
      trend,
      history,
      fetchedAt: Date.now(),
    };

    cachedResult = result;
    lastFetchTime = Date.now();

    logger.info(TAG, `공포탐욕지수: ${value} (${label}) → ${signal}, 추세: ${trend}`);

    return result;
  } catch (error) {
    logger.warn(TAG, `공포탐욕지수 조회 실패: ${error.message}`);
    // 실패 시 캐시된 결과 반환 or 기본값
    return cachedResult || {
      value: 50,
      label: 'Neutral',
      signal: 'neutral',
      buyBoost: 0,
      trend: 'stable',
      history: [],
      fetchedAt: 0,
      error: error.message,
    };
  }
}

module.exports = { analyzeFearGreed };
