/**
 * BTC 선행 지표 (BTC Leader)
 *
 * BTC가 알트코인보다 5~15분 먼저 움직이는 경향을 활용
 * BTC가 급등/급락하면 알트코인 시그널에 부스트/감소 적용
 *
 * 실시간으로 BTC 가격을 추적하며 최근 변화율 분석
 */

class BTCLeader {
  constructor() {
    this.priceHistory = []; // { price, time }
    this.maxHistory = 200;  // 약 30분 (10초 간격)
    this.lastUpdate = 0;
  }

  /**
   * BTC 가격 업데이트 (스캔마다 호출)
   * @param {number} price - BTC/KRW 현재가
   */
  update(price) {
    if (!price || price <= 0) return;

    const now = Date.now();
    // 최소 5초 간격
    if (now - this.lastUpdate < 5000) return;

    this.priceHistory.push({ price, time: now });
    this.lastUpdate = now;

    // 오래된 데이터 정리 (30분 이상)
    const cutoff = now - 1800000;
    while (this.priceHistory.length > 0 && this.priceHistory[0].time < cutoff) {
      this.priceHistory.shift();
    }

    // 최대 크기 제한
    if (this.priceHistory.length > this.maxHistory) {
      this.priceHistory = this.priceHistory.slice(-this.maxHistory);
    }
  }

  /**
   * BTC 선행 시그널 분석
   * @returns {{ signal, buyBoost, sellBoost, changes, momentum }}
   */
  getSignal() {
    if (this.priceHistory.length < 10) {
      return { signal: 'neutral', buyBoost: 0, sellBoost: 0, changes: {}, momentum: 0 };
    }

    const now = Date.now();
    const current = this.priceHistory[this.priceHistory.length - 1].price;

    // 시간대별 변화율 계산
    const changes = {};
    for (const [label, ms] of [['1m', 60000], ['3m', 180000], ['5m', 300000], ['10m', 600000], ['15m', 900000]]) {
      const target = now - ms;
      const entry = this._findClosest(target);
      if (entry) {
        changes[label] = Math.round(((current - entry.price) / entry.price) * 10000) / 100; // %
      }
    }

    // 모멘텀: 최근 5분 이동 방향 강도
    const c5m = changes['5m'] || 0;
    const c1m = changes['1m'] || 0;

    // 가속도: 1분 변화가 5분 추세 방향으로 가속 중인지
    const accelerating = (c5m > 0 && c1m > c5m / 5) || (c5m < 0 && c1m < c5m / 5);

    let signal = 'neutral';
    let buyBoost = 0;
    let sellBoost = 0;

    // BTC 급등 감지 → 알트코인 매수 부스트
    if (c5m >= 1.5 || (c5m >= 0.8 && accelerating)) {
      signal = 'strong_buy';
      buyBoost = 1.5;
    } else if (c5m >= 0.5) {
      signal = 'buy';
      buyBoost = 0.8;
    } else if (c5m >= 0.3 && c1m > 0) {
      signal = 'weak_buy';
      buyBoost = 0.3;
    }

    // BTC 급락 감지 → 알트코인 매도/매수 차단
    if (c5m <= -1.5 || (c5m <= -0.8 && accelerating)) {
      signal = 'strong_sell';
      sellBoost = 1.5;
      buyBoost = 0;
    } else if (c5m <= -0.5) {
      signal = 'sell';
      sellBoost = 0.8;
      buyBoost = 0;
    } else if (c5m <= -0.3 && c1m < 0) {
      signal = 'weak_sell';
      sellBoost = 0.3;
      buyBoost = Math.max(0, buyBoost - 0.3);
    }

    // 10분/15분 추세 보너스 (같은 방향이면 확신도 높음)
    const c10m = changes['10m'] || 0;
    const c15m = changes['15m'] || 0;
    if (c5m > 0 && c10m > 0 && c15m > 0) {
      buyBoost += 0.3; // 장기 상승 추세 확인
    }
    if (c5m < 0 && c10m < 0 && c15m < 0) {
      sellBoost += 0.3; // 장기 하락 추세 확인
    }

    return {
      signal,
      buyBoost: Math.round(buyBoost * 100) / 100,
      sellBoost: Math.round(sellBoost * 100) / 100,
      changes,
      momentum: Math.round(c5m * 100) / 100,
      accelerating,
      historySize: this.priceHistory.length,
    };
  }

  /**
   * 특정 시간에 가장 가까운 가격 항목 찾기
   */
  _findClosest(targetTime) {
    if (this.priceHistory.length === 0) return null;

    let closest = null;
    let minDiff = Infinity;

    for (const entry of this.priceHistory) {
      const diff = Math.abs(entry.time - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = entry;
      }
    }

    // 5분 이상 차이나면 신뢰할 수 없음
    if (minDiff > 300000) return null;
    return closest;
  }

  /**
   * 상태 요약 (대시보드용)
   */
  getSummary() {
    const sig = this.getSignal();
    return {
      signal: sig.signal,
      momentum: sig.momentum,
      changes: sig.changes,
      historySize: sig.historySize,
    };
  }
}

module.exports = { BTCLeader };
