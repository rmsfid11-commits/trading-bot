/**
 * 상관관계 분석 + 고급 리스크 관리
 *
 * - 종목 간 상관계수 계산 → 유사 종목 동시 보유 방지
 * - 드로다운 추적 → 연속 손실 시 포지션 축소
 * - 샤프 비율 추적
 */

const fs = require('fs');
const path = require('path');

const RISK_STATE_PATH = path.join(__dirname, '../../logs/risk-state.json');

/**
 * 피어슨 상관계수 계산
 * @param {number[]} x - 종목A 수익률 배열
 * @param {number[]} y - 종목B 수익률 배열
 * @returns {number} -1 ~ +1
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  const ax = x.slice(-n);
  const ay = y.slice(-n);

  const meanX = ax.reduce((s, v) => s + v, 0) / n;
  const meanY = ay.reduce((s, v) => s + v, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = ax[i] - meanX;
    const dy = ay[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}

/**
 * 캔들 배열에서 수익률 배열 추출
 */
function getReturns(candles) {
  const closes = candles.map(c => c.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}

/**
 * 현재 보유 종목과 새 종목의 상관관계 체크
 * @param {Object} candlesMap - { symbol: candles[] }
 * @param {string} newSymbol - 매수 후보 종목
 * @param {string[]} heldSymbols - 현재 보유 종목들
 * @param {number} threshold - 상관계수 임계값 (기본 0.7)
 * @returns { allowed, highCorr: [{ symbol, correlation }] }
 */
function checkCorrelation(candlesMap, newSymbol, heldSymbols, threshold = 0.7) {
  const newCandles = candlesMap[newSymbol];
  if (!newCandles || newCandles.length < 20) {
    return { allowed: true, highCorr: [] };
  }

  const newReturns = getReturns(newCandles);
  const highCorr = [];

  for (const held of heldSymbols) {
    const heldCandles = candlesMap[held];
    if (!heldCandles || heldCandles.length < 20) continue;

    const heldReturns = getReturns(heldCandles);
    const corr = pearsonCorrelation(newReturns, heldReturns);

    if (Math.abs(corr) >= threshold) {
      highCorr.push({ symbol: held, correlation: corr });
    }
  }

  return {
    allowed: highCorr.length === 0,
    highCorr,
  };
}

/**
 * 드로다운 기반 동적 포지션 제한
 */
class DrawdownTracker {
  constructor() {
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(RISK_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(RISK_STATE_PATH, 'utf-8'));
      }
    } catch { }
    return {
      peakBalance: 0,
      currentBalance: 0,
      consecutiveLosses: 0,
      recentPnls: [],     // 최근 20거래 수익률
      maxDrawdownPct: 0,
      sharpeData: [],      // 최근 거래 수익률 (샤프 비율용)
    };
  }

  _save() {
    try {
      const dir = path.dirname(RISK_STATE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(RISK_STATE_PATH, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch { }
  }

  updateBalance(balance) {
    this.state.currentBalance = balance;
    if (balance > this.state.peakBalance) {
      this.state.peakBalance = balance;
    }
    this._save();
  }

  recordTrade(pnlPct) {
    // 연속 손실 추적
    if (pnlPct <= 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // 최근 거래 기록
    this.state.recentPnls.push(pnlPct);
    if (this.state.recentPnls.length > 20) {
      this.state.recentPnls = this.state.recentPnls.slice(-20);
    }

    // 샤프 데이터
    this.state.sharpeData.push(pnlPct);
    if (this.state.sharpeData.length > 50) {
      this.state.sharpeData = this.state.sharpeData.slice(-50);
    }

    // 최대 드로다운 갱신
    if (this.state.peakBalance > 0) {
      const dd = (this.state.peakBalance - this.state.currentBalance) / this.state.peakBalance * 100;
      if (dd > this.state.maxDrawdownPct) {
        this.state.maxDrawdownPct = Math.round(dd * 100) / 100;
      }
    }

    this._save();
  }

  /**
   * 드로다운 기반 최대 포지션 수 조절
   * 기본 5개, 연속 손실 시 줄임
   */
  getMaxPositions(baseMax = 5) {
    const losses = this.state.consecutiveLosses;
    if (losses >= 5) return Math.max(1, baseMax - 3); // 5연패: 2개
    if (losses >= 3) return Math.max(2, baseMax - 2); // 3연패: 3개
    if (losses >= 2) return Math.max(3, baseMax - 1); // 2연패: 4개
    return baseMax;
  }

  /**
   * 포지션 사이징 배율 (드로다운 기반)
   * 연속 손실 시 투자 비중 축소
   */
  getSizingMultiplier() {
    const losses = this.state.consecutiveLosses;
    if (losses >= 5) return 0.5;  // 50%
    if (losses >= 3) return 0.7;  // 70%
    if (losses >= 2) return 0.85; // 85%
    return 1.0;
  }

  /**
   * 샤프 비율 계산 (무위험 수익률 = 0 가정)
   */
  getSharpeRatio() {
    const data = this.state.sharpeData;
    if (data.length < 5) return 0;

    const mean = data.reduce((s, v) => s + v, 0) / data.length;
    const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length;
    const std = Math.sqrt(variance);

    return std === 0 ? 0 : Math.round((mean / std) * 100) / 100;
  }

  getState() {
    return {
      ...this.state,
      sharpeRatio: this.getSharpeRatio(),
      dynamicMaxPositions: this.getMaxPositions(),
      sizingMultiplier: this.getSizingMultiplier(),
    };
  }
}

module.exports = { pearsonCorrelation, getReturns, checkCorrelation, DrawdownTracker };
