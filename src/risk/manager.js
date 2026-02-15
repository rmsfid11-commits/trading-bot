const fs = require('fs');
const path = require('path');
const { STRATEGY } = require('../config/strategy');
const { logger } = require('../logger/trade-logger');
const { getDynamicSLTP } = require('../indicators/atr');

const TAG = 'RISK';
const POSITIONS_FILE = path.join(__dirname, '../../logs/positions.json');
const TRADES_FILE = path.join(__dirname, '../../logs/trades.jsonl');

const { DrawdownTracker } = require('./correlation');

const RISK_LIMITS = {
  MAX_DAILY_LOSS_PCT: 5,
  MAX_POSITIONS: 5,
  MAX_POSITION_PCT: 20,
};

class RiskManager {
  constructor() {
    this.dailyPnl = 0;
    this.initialBalance = 0;
    this.positions = new Map();
    this.cooldowns = new Map(); // symbol → timestamp (매도 후 쿨다운)
    this.dailyResetTime = this.getNextResetTime();
    this.drawdownTracker = new DrawdownTracker();
    this._loadPositions();
    this._loadDailyPnlFromLog();
  }

  _loadPositions() {
    try {
      if (fs.existsSync(POSITIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
        for (const [symbol, pos] of Object.entries(data.positions || {})) {
          this.positions.set(symbol, pos);
        }
        if (this.positions.size > 0) {
          const symbols = [...this.positions.keys()].join(', ');
          logger.info(TAG, `저장된 포지션 복구: ${this.positions.size}개 (${symbols})`);
        }
      }
    } catch (e) {
      logger.warn(TAG, `포지션 파일 로드 실패: ${e.message}`);
    }
  }

  _loadDailyPnlFromLog() {
    try {
      if (!fs.existsSync(TRADES_FILE)) return;
      const lines = fs.readFileSync(TRADES_FILE, 'utf-8').trim().split('\n').filter(Boolean);

      // 오늘 자정 기준
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayMs = todayStart.getTime();

      const todayTrades = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(t => t && t.timestamp >= todayMs);

      const todayBuys = todayTrades.filter(t => t.action === 'BUY');
      const todaySells = todayTrades.filter(t => t.action === 'SELL');

      // 매도 건에서 실현 손익 합산 (pnl은 %로 기록, 실제 금액은 매수금액 * pnl% 로 추정)
      // 매도와 매칭되는 매수를 찾아서 실제 손익 계산
      let realizedPnl = 0;
      for (const sell of todaySells) {
        if (sell.pnl == null) continue;
        // 해당 심볼의 가장 최근 매수를 찾아 금액 추정
        const matchBuy = [...todayBuys].reverse().find(b => b.symbol === sell.symbol && b.timestamp < sell.timestamp);
        if (matchBuy) {
          const buyAmount = matchBuy.price * matchBuy.quantity;
          realizedPnl += buyAmount * (sell.pnl / 100);
        }
      }

      this.dailyPnl = Math.round(realizedPnl);
      this.todayStats = {
        totalBuys: todayBuys.length,
        totalSells: todaySells.length,
        wins: todaySells.filter(t => t.pnl > 0).length,
        losses: todaySells.filter(t => t.pnl != null && t.pnl <= 0).length,
      };

      if (todaySells.length > 0) {
        logger.info(TAG, `오늘 매매 복구: ${todayBuys.length}매수 / ${todaySells.length}매도 | 승 ${this.todayStats.wins} 패 ${this.todayStats.losses} | 실현손익 ${this.dailyPnl >= 0 ? '+' : ''}${this.dailyPnl.toLocaleString()}원`);
      }
    } catch (e) {
      logger.warn(TAG, `매매 기록 로드 실패: ${e.message}`);
    }
  }

  getTodayStats() {
    return this.todayStats || { totalBuys: 0, totalSells: 0, wins: 0, losses: 0 };
  }

  _savePositions() {
    try {
      const dir = path.dirname(POSITIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        positions: Object.fromEntries(this.positions),
        dailyPnl: this.dailyPnl,
        savedAt: Date.now(),
      };
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error(TAG, `포지션 저장 실패: ${e.message}`);
    }
  }

  getNextResetTime() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  resetDaily() {
    if (Date.now() >= this.dailyResetTime) {
      this.dailyPnl = 0;
      this.dailyResetTime = this.getNextResetTime();
      logger.info(TAG, '일일 손익 초기화');
      this._savePositions();
    }
  }

  setBalance(balance) {
    if (this.initialBalance === 0) this.initialBalance = balance;
  }

  canOpenPosition(symbol, amount, balance) {
    this.resetDaily();

    // 일일 최대 손실 체크
    const maxLoss = this.initialBalance * (RISK_LIMITS.MAX_DAILY_LOSS_PCT / 100);
    if (this.dailyPnl <= -maxLoss) {
      logger.warn(TAG, `일일 최대 손실 도달: ${this.dailyPnl.toLocaleString()}원`, { limit: maxLoss });
      return { allowed: false, reason: '일일 최대 손실 도달' };
    }

    // 동시 포지션 제한 (드로다운 기반 동적 제한)
    const maxPos = this.drawdownTracker.getMaxPositions(RISK_LIMITS.MAX_POSITIONS);
    if (this.positions.size >= maxPos) {
      logger.warn(TAG, `최대 포지션 수 도달: ${this.positions.size}/${maxPos} (기본 ${RISK_LIMITS.MAX_POSITIONS})`);
      return { allowed: false, reason: `최대 포지션 수 도달 (${maxPos}개, 드로다운 조절)` };
    }

    // 이미 해당 종목 포지션 있음
    if (this.positions.has(symbol)) {
      return { allowed: false, reason: '이미 포지션 보유 중' };
    }

    // 매도 후 쿨다운 (3분)
    const cooldown = this.cooldowns.get(symbol);
    if (cooldown && Date.now() - cooldown < 180000) {
      const remain = Math.ceil((180000 - (Date.now() - cooldown)) / 1000);
      return { allowed: false, reason: `매도 후 쿨다운 (${remain}초)` };
    }

    // 종목당 최대 비율
    const maxAmount = balance * (RISK_LIMITS.MAX_POSITION_PCT / 100);
    if (amount > maxAmount) {
      return { allowed: false, reason: `종목당 최대 비율 초과 (${RISK_LIMITS.MAX_POSITION_PCT}%)` };
    }

    return { allowed: true, maxAmount };
  }

  openPosition(symbol, entryPrice, quantity, amount, candles = null) {
    // ATR 기반 동적 SL/TP (캔들 데이터 있으면 사용)
    let slPct = STRATEGY.STOP_LOSS_PCT;
    let tpPct = STRATEGY.TAKE_PROFIT_PCT;
    let atrPct = 0;

    if (candles && candles.length > 15) {
      const dynamicSLTP = getDynamicSLTP(candles);
      if (dynamicSLTP && dynamicSLTP.atrPct > 0) {
        slPct = dynamicSLTP.stopLossPct;
        tpPct = dynamicSLTP.takeProfitPct;
        atrPct = dynamicSLTP.atrPct;
      }
    }

    const stopLoss = entryPrice * (1 + slPct / 100);
    const takeProfit = entryPrice * (1 + tpPct / 100);
    const maxHoldTime = Date.now() + STRATEGY.MAX_HOLD_HOURS * 3600000;

    this.positions.set(symbol, {
      entryPrice,
      quantity,
      amount,
      stopLoss,
      takeProfit,
      maxHoldTime,
      highestPrice: entryPrice,
      entryTime: Date.now(),
      atrPct, // ATR 변동성 기록
    });

    logger.info(TAG, `포지션 오픈: ${symbol}`, {
      entryPrice, stopLoss: Math.round(stopLoss), takeProfit: Math.round(takeProfit),
      slPct, tpPct, atrPct: atrPct ? atrPct.toFixed(2) + '%' : 'N/A',
    });
    this._savePositions();
  }

  checkPosition(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // 트레일링 스탑: 최고가 갱신 시 손절선도 올림
    if (currentPrice > (pos.highestPrice || pos.entryPrice)) {
      pos.highestPrice = currentPrice;
      const trailingStop = currentPrice * (1 + STRATEGY.STOP_LOSS_PCT / 100);
      if (trailingStop > pos.stopLoss) {
        pos.stopLoss = trailingStop;
        this._savePositions();
      }
    }

    if (currentPrice <= pos.stopLoss) return { action: 'SELL', reason: `손절 (${pnlPct.toFixed(2)}%)`, pnlPct };
    if (currentPrice >= pos.takeProfit) return { action: 'SELL', reason: `익절 (${pnlPct.toFixed(2)}%)`, pnlPct };
    if (Date.now() >= pos.maxHoldTime) return { action: 'SELL', reason: `최대 보유시간 초과 (${pnlPct.toFixed(2)}%)`, pnlPct };

    return null;
  }

  closePosition(symbol, exitPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    const pnl = (exitPrice - pos.entryPrice) * pos.quantity;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    this.dailyPnl += pnl;
    this.positions.delete(symbol);
    this.cooldowns.set(symbol, Date.now());

    // 드로다운 트래커 업데이트
    this.drawdownTracker.recordTrade(pnlPct);

    logger.info(TAG, `포지션 종료: ${symbol}`, { pnl: Math.round(pnl), dailyPnl: Math.round(this.dailyPnl) });
    this._savePositions();
    return pnl;
  }

  /**
   * 분할매도: 포지션의 일부만 매도
   * @param {string} symbol
   * @param {number} fraction - 매도 비율 (0.0 ~ 1.0)
   * @param {number} exitPrice
   * @returns {{ sellQty, remainQty, pnl }}
   */
  partialClose(symbol, fraction, exitPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    fraction = Math.max(0.1, Math.min(1.0, fraction));
    const sellQty = pos.quantity * fraction;
    const remainQty = pos.quantity - sellQty;

    const pnl = (exitPrice - pos.entryPrice) * sellQty;
    this.dailyPnl += pnl;

    if (remainQty < pos.quantity * 0.05) {
      // 남은 수량이 너무 적으면 전량 매도 처리
      this.positions.delete(symbol);
      this.cooldowns.set(symbol, Date.now());
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      this.drawdownTracker.recordTrade(pnlPct);
      logger.info(TAG, `분할매도 (전량): ${symbol}`, { fraction, pnl: Math.round(pnl) });
    } else {
      // 남은 수량 업데이트, 익절선 위로 올림
      pos.quantity = remainQty;
      pos.amount = Math.round(pos.entryPrice * remainQty);
      // 분할매도 후 손절선을 진입가로 올림 (본전 보장)
      if (exitPrice > pos.entryPrice) {
        pos.stopLoss = Math.max(pos.stopLoss, pos.entryPrice * 0.998);
      }
      pos.partialSells = (pos.partialSells || 0) + 1;
      logger.info(TAG, `분할매도 ${Math.round(fraction * 100)}%: ${symbol}`, {
        sold: sellQty.toFixed(6), remaining: remainQty.toFixed(6), pnl: Math.round(pnl),
      });
    }

    this._savePositions();
    return { sellQty, remainQty, pnl };
  }

  /**
   * DCA (물타기): 기존 포지션에 추가 매수
   * @param {string} symbol
   * @param {number} newPrice - 추가 매수 가격
   * @param {number} newQuantity - 추가 매수 수량
   * @param {number} newAmount - 추가 매수 금액 (KRW)
   */
  addToPosition(symbol, newPrice, newQuantity, newAmount) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const totalQty = pos.quantity + newQuantity;
    const totalAmount = pos.amount + newAmount;
    const newAvgPrice = totalAmount / totalQty;

    // 평균매수가 재계산
    pos.entryPrice = newAvgPrice;
    pos.quantity = totalQty;
    pos.amount = totalAmount;

    // 손절/익절선 재계산
    pos.stopLoss = newAvgPrice * (1 + STRATEGY.STOP_LOSS_PCT / 100);
    pos.takeProfit = newAvgPrice * (1 + STRATEGY.TAKE_PROFIT_PCT / 100);
    pos.highestPrice = Math.max(pos.highestPrice || newAvgPrice, newPrice);
    pos.dcaCount = (pos.dcaCount || 0) + 1;

    logger.info(TAG, `DCA 추가매수: ${symbol}`, {
      newAvgPrice: Math.round(newAvgPrice), totalQty: totalQty.toFixed(6),
      dcaCount: pos.dcaCount,
    });

    this._savePositions();
    return { avgPrice: newAvgPrice, totalQty, dcaCount: pos.dcaCount };
  }

  /**
   * 분할매도 체크: 수익률 단계별 분할매도 기준
   * @returns {{ shouldPartialSell, fraction, reason }} or null
   */
  checkPartialExit(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const partialSells = pos.partialSells || 0;

    // 단계별 분할매도 기준 (익절 2.5% 기준)
    // 1차: +2.5% → 30% 매도 (빠른 수익 확보)
    // 2차: +4% → 40% 매도 (남은 수량 중)
    // 3차: +6% → 전량 매도 (큰 수익)
    if (partialSells === 0 && pnlPct >= 2.5) {
      return { shouldPartialSell: true, fraction: 0.3, reason: `1차 분할익절 (+${pnlPct.toFixed(1)}%)`, pnlPct };
    }
    if (partialSells === 1 && pnlPct >= 4) {
      return { shouldPartialSell: true, fraction: 0.4, reason: `2차 분할익절 (+${pnlPct.toFixed(1)}%)`, pnlPct };
    }
    if (partialSells >= 1 && pnlPct >= 6) {
      return { shouldPartialSell: true, fraction: 1.0, reason: `최종 익절 (+${pnlPct.toFixed(1)}%)`, pnlPct };
    }

    return null;
  }

  /**
   * DCA 조건 체크: 현재 포지션이 하락했지만 시그널이 여전히 강할 때
   * @returns {{ shouldDCA, reason }} or null
   */
  checkDCACondition(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const dcaCount = pos.dcaCount || 0;
    const holdMin = (Date.now() - pos.entryTime) / 60000;

    // DCA 조건:
    // - 현재 -2% ~ -5% 하락
    // - 최대 2회 DCA
    // - 최소 30분 보유 후
    if (pnlPct <= -2 && pnlPct >= -5 && dcaCount < 2 && holdMin >= 30) {
      return {
        shouldDCA: true,
        reason: `물타기 ${dcaCount + 1}차 (${pnlPct.toFixed(1)}%)`,
        dcaCount: dcaCount + 1,
      };
    }

    return null;
  }

  /** 드로다운 트래커 상태 */
  getDrawdownState() {
    return this.drawdownTracker.getState();
  }

  /** 포지션 사이징 배율 (드로다운 기반) */
  getSizingMultiplier() {
    return this.drawdownTracker.getSizingMultiplier();
  }

  removePosition(symbol, reason) {
    if (this.positions.has(symbol)) {
      this.positions.delete(symbol);
      logger.info(TAG, `포지션 제거 (동기화): ${symbol} - ${reason}`);
      this._savePositions();
    }
  }

  getPositions() {
    return Object.fromEntries(this.positions);
  }

  getDailyPnl() {
    return this.dailyPnl;
  }
}

module.exports = { RiskManager };
