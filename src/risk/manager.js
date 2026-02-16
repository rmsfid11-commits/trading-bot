const fs = require('fs');
const path = require('path');
const { STRATEGY } = require('../config/strategy');
const { logger } = require('../logger/trade-logger');
const { getDynamicSLTP } = require('../indicators/atr');

const TAG = 'RISK';
const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');

const { DrawdownTracker } = require('./correlation');

const RISK_LIMITS = {
  MAX_DAILY_LOSS_PCT: 5,
  MAX_POSITIONS: STRATEGY.MAX_POSITIONS || 3,
  MAX_POSITION_PCT: 35, // calcPositionSize 최대 30% + 여유분
};

class RiskManager {
  constructor(logDir = null) {
    const dir = logDir || DEFAULT_LOG_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.logDir = dir;
    this.positionsFile = path.join(dir, 'positions.json');
    this.tradesFile = path.join(dir, 'trades.jsonl');
    this.protectedCoinsFile = path.join(dir, 'protected-coins.json');
    this.dailyPnl = 0;
    this.initialBalance = 0;
    this.positions = new Map();
    this.protectedCoins = new Map(); // symbol → { quantity, avgBuyPrice, protectedAt }
    this.cooldowns = new Map(); // symbol → timestamp (매도 후 쿨다운)
    this.buyTimestamps = [];     // 최근 매수 시각 기록 (시간당 제한용)
    this.dailyResetTime = this.getNextResetTime();
    this.drawdownTracker = new DrawdownTracker(logDir);
    // 연속 손실 추적 (스마트 적응 필터)
    this.consecutiveLosses = 0;
    this.lastLossTime = 0;
    this._loadPositions();
    this._loadProtectedCoins();
    this._loadDailyPnlFromLog();
  }

  _loadPositions() {
    try {
      if (fs.existsSync(this.positionsFile)) {
        const data = JSON.parse(fs.readFileSync(this.positionsFile, 'utf-8'));
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

  _loadProtectedCoins() {
    try {
      if (fs.existsSync(this.protectedCoinsFile)) {
        const data = JSON.parse(fs.readFileSync(this.protectedCoinsFile, 'utf-8'));
        for (const [symbol, info] of Object.entries(data.coins || {})) {
          this.protectedCoins.set(symbol, info);
        }
        if (this.protectedCoins.size > 0) {
          const symbols = [...this.protectedCoins.keys()].join(', ');
          logger.info(TAG, `보호 코인 로드: ${this.protectedCoins.size}개 (${symbols})`);
        }
      }
    } catch (e) {
      logger.warn(TAG, `보호 코인 파일 로드 실패: ${e.message}`);
    }
  }

  _saveProtectedCoins() {
    try {
      const data = {
        coins: Object.fromEntries(this.protectedCoins),
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.protectedCoinsFile, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error(TAG, `보호 코인 저장 실패: ${e.message}`);
    }
  }

  /**
   * 봇 최초 시작 시 거래소 보유 코인을 보호 목록에 등록
   * 이미 보호 목록이 있으면 새 코인만 추가 (봇이 매수한 것은 제외)
   */
  initProtectedCoins(exchangeHoldings) {
    if (!exchangeHoldings) return;

    let newCount = 0;
    for (const [symbol, info] of Object.entries(exchangeHoldings)) {
      if (info.quantity <= 0) continue;
      const amount = info.avgBuyPrice * info.quantity;
      if (amount < 1000) continue;

      // 이미 봇이 관리하는 포지션이면 보호 대상 아님
      if (this.positions.has(symbol)) continue;

      // 이미 보호 목록에 있으면 스킵
      if (this.protectedCoins.has(symbol)) continue;

      this.protectedCoins.set(symbol, {
        quantity: info.quantity,
        avgBuyPrice: info.avgBuyPrice,
        protectedAt: Date.now(),
      });
      newCount++;
      logger.info(TAG, `보호 코인 등록: ${symbol} (${info.quantity}개, 평균가 ${info.avgBuyPrice.toLocaleString()}원)`);
    }

    if (newCount > 0) {
      this._saveProtectedCoins();
      logger.info(TAG, `보호 코인 ${newCount}개 새로 등록 (총 ${this.protectedCoins.size}개)`);
    }
  }

  /**
   * 해당 심볼이 보호 코인인지 확인
   */
  isProtectedCoin(symbol) {
    return this.protectedCoins.has(symbol);
  }

  /**
   * 보호 코인 목록 반환
   */
  getProtectedCoins() {
    return Object.fromEntries(this.protectedCoins);
  }

  _loadDailyPnlFromLog() {
    try {
      if (!fs.existsSync(this.tradesFile)) return;
      const lines = fs.readFileSync(this.tradesFile, 'utf-8').trim().split('\n').filter(Boolean);

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

  /**
   * 스마트 적응 필터 — 현재 상태 기반 매매 제한 조건 반환
   * @param {number} fgValue - Fear & Greed 지수 (0-100)
   * @returns {{ nightBlock, lossCooldown, minScoreBoost, sizeMultiplier, reasons }}
   */
  getAdaptiveFilter(fgValue = 50) {
    const result = { nightBlock: false, lossCooldown: false, minScoreBoost: 0, sizeMultiplier: 1.0, reasons: [] };
    const hour = new Date().getHours();

    // 1. 새벽 시간대 (00-06시) → 매수 기준 강화 (거래량 감소, 但 미국 시간대 겹침)
    if (hour >= 0 && hour < 6) {
      result.minScoreBoost += 0.5;
      result.reasons.push(`새벽 시간(${hour}시) 매수 기준 +0.5`);
    }

    // 2. 연속 2패 이상 → 30분 강제 쿨다운 + 매수 기준 +0.5
    if (this.consecutiveLosses >= 2) {
      const cooldownMs = 1800000; // 30분
      const elapsed = Date.now() - this.lastLossTime;
      if (elapsed < cooldownMs) {
        result.lossCooldown = true;
        result.reasons.push(`연속 ${this.consecutiveLosses}패 → ${Math.ceil((cooldownMs - elapsed) / 60000)}분 쿨다운`);
      }
      result.minScoreBoost += 0.5;
      result.reasons.push(`연속 패배 → 매수 기준 +0.5`);
    }

    // 3. F&G 극단 공포 (< 20) → 최소 매수 점수 +1.0 상향
    if (fgValue < 20) {
      result.minScoreBoost += 1.0;
      result.reasons.push(`F&G 극단 공포(${fgValue}) → 매수 기준 +1.0`);
    }

    // 4. 오늘 승률 < 40% (5거래 이상) → 포지션 크기 50% 축소
    const stats = this.getTodayStats();
    const totalSells = stats.wins + stats.losses;
    if (totalSells >= 5) {
      const winRate = stats.wins / totalSells * 100;
      if (winRate < 40) {
        result.sizeMultiplier = 0.5;
        result.reasons.push(`오늘 승률 ${Math.round(winRate)}% → 포지션 50% 축소`);
      }
    }

    return result;
  }

  _savePositions() {
    try {
      const dir = path.dirname(this.positionsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        positions: Object.fromEntries(this.positions),
        dailyPnl: this.dailyPnl,
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.positionsFile, JSON.stringify(data, null, 2));
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

  canOpenPosition(symbol, amount, balance, isScalpEligible = false) {
    this.resetDaily();

    // 일일 절대 손실 한도 체크 (원 기준)
    const dailyLimit = STRATEGY.DAILY_LOSS_LIMIT || -10000;
    if (this.dailyPnl <= dailyLimit) {
      logger.warn(TAG, `일일 손실 한도 도달: ${this.dailyPnl.toLocaleString()}원 (한도 ${dailyLimit.toLocaleString()}원)`);
      return { allowed: false, reason: `일일 손실 한도 도달 (${dailyLimit.toLocaleString()}원)` };
    }

    // 일일 한도 근접 시 (80%) 경고 + 쿨다운
    if (this.dailyPnl <= dailyLimit * 0.8) {
      const recoveryCooldown = STRATEGY.RECOVERY_COOLDOWN_MS || 1800000;
      const lastBuy = this.buyTimestamps[this.buyTimestamps.length - 1];
      if (lastBuy && Date.now() - lastBuy < recoveryCooldown) {
        const remain = Math.ceil((recoveryCooldown - (Date.now() - lastBuy)) / 60000);
        return { allowed: false, reason: `손실 한도 근접 → 회복 대기 (${remain}분)` };
      }
    }

    // 일일 최대 손실 체크 (비율 기준)
    const maxLoss = this.initialBalance * (RISK_LIMITS.MAX_DAILY_LOSS_PCT / 100);
    if (this.dailyPnl <= -maxLoss) {
      logger.warn(TAG, `일일 최대 손실(%) 도달: ${this.dailyPnl.toLocaleString()}원`, { limit: maxLoss });
      return { allowed: false, reason: '일일 최대 손실(%) 도달' };
    }

    // 시간당 매수 제한
    const hourlyMax = STRATEGY.HOURLY_MAX_TRADES || 3;
    const oneHourAgo = Date.now() - 3600000;
    this.buyTimestamps = this.buyTimestamps.filter(t => t > oneHourAgo);
    if (this.buyTimestamps.length >= hourlyMax) {
      return { allowed: false, reason: `시간당 최대 매수 (${hourlyMax}회) 도달` };
    }

    // 동시 포지션 제한 (드로다운 기반 동적 제한)
    const maxPos = this.drawdownTracker.getMaxPositions(RISK_LIMITS.MAX_POSITIONS);
    const scalpExtra = isScalpEligible ? (STRATEGY.SCALP_EXTRA_POSITIONS || 1) : 0;
    const effectiveMax = maxPos + scalpExtra;
    if (this.positions.size >= effectiveMax) {
      if (isScalpEligible) {
        logger.warn(TAG, `스캘핑 추가 슬롯 포함해도 포지션 초과: ${this.positions.size}/${effectiveMax}`);
      } else {
        logger.warn(TAG, `최대 포지션 수 도달: ${this.positions.size}/${maxPos} (기본 ${RISK_LIMITS.MAX_POSITIONS})`);
      }
      return { allowed: false, reason: `최대 포지션 수 도달 (${effectiveMax}개${scalpExtra ? ', 스캘핑+' + scalpExtra : ''})` };
    }
    if (isScalpEligible && this.positions.size >= maxPos) {
      logger.info(TAG, `스캘핑 추가 슬롯 사용: ${this.positions.size + 1}/${effectiveMax} (기본 ${maxPos} + 스캘핑 ${scalpExtra})`);
    }

    // 이미 해당 종목 포지션 있음
    if (this.positions.has(symbol)) {
      return { allowed: false, reason: '이미 포지션 보유 중' };
    }

    // 매도 후 쿨다운 (15분)
    const cooldownMs = STRATEGY.COOLDOWN_MS || 900000;
    const cooldown = this.cooldowns.get(symbol);
    if (cooldown && Date.now() - cooldown < cooldownMs) {
      const remain = Math.ceil((cooldownMs - (Date.now() - cooldown)) / 1000);
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
      dcaCount: 0,
      lastDcaTime: null,
    });

    // 시간당 매수 제한용 기록
    this.buyTimestamps.push(Date.now());

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
    const holdMs = Date.now() - pos.entryTime;
    const holdHours = holdMs / 3600000;
    let changed = false;

    // ─── 1. 브레이크이븐: +1.5% 도달 시 손절선을 진입가로 이동 ───
    const beTrigger = STRATEGY.BREAKEVEN_TRIGGER_PCT || 1.5;
    if (!pos.breakevenSet && pnlPct >= beTrigger) {
      const newStop = pos.entryPrice * 1.001; // 진입가 +0.1% (수수료 고려)
      if (newStop > pos.stopLoss) {
        pos.stopLoss = newStop;
        pos.breakevenSet = true;
        changed = true;
        logger.info(TAG, `브레이크이븐 활성: ${symbol} (손절선 → ${Math.round(newStop)})`);
      }
    }

    // ─── 2. 트레일링 스탑: +2.5% 이후 최고가 추적 ───
    const trailActivate = STRATEGY.TRAILING_ACTIVATE_PCT || 2.5;
    const trailDist = STRATEGY.TRAILING_DISTANCE_PCT || 1.2;

    if (currentPrice > (pos.highestPrice || pos.entryPrice)) {
      pos.highestPrice = currentPrice;
      changed = true;
    }

    if (pnlPct >= trailActivate) {
      // 트레일링 모드: 최고가 대비 -1.2% 하락 시 매도
      const trailingStop = pos.highestPrice * (1 - trailDist / 100);
      if (trailingStop > pos.stopLoss) {
        pos.stopLoss = trailingStop;
        pos.trailingActive = true;
        changed = true;
      }
    }

    if (changed) this._savePositions();

    // ─── 매도 조건 체크 (휩쏘 방지 강화) ───
    if (currentPrice <= pos.stopLoss) {
      const now = Date.now();

      // 급락이면 즉시 매도 (휩쏘가 아니라 진짜 폭락)
      const hardDrop = STRATEGY.HARD_DROP_PCT || -4;
      if (pnlPct <= hardDrop) {
        const reason = `급락 손절 (${pnlPct.toFixed(2)}%)`;
        return { action: 'SELL', reason, pnlPct };
      }

      // RSI 극단적 과매도 보호: RSI < 20이면 손절 유예 (반등 가능성 높음)
      const rsiProtection = STRATEGY.RSI_OVERSOLD_PROTECTION || 20;
      if (pos.lastRsi != null && pos.lastRsi < rsiProtection) {
        if (!pos.rsiProtectionLogged) {
          logger.info(TAG, `${symbol} RSI ${pos.lastRsi.toFixed(1)} < ${rsiProtection} → 손절 유예 (극과매도 반등 대기)`);
          pos.rsiProtectionLogged = true;
          this._savePositions();
        }
        return null; // 손절 유예
      }

      // 첫 터치 시각 기록
      if (!pos.firstStopHitTime) {
        pos.firstStopHitTime = now;
        pos.stopHitCount = 1;
        pos.lastStopHitTime = now;
        logger.info(TAG, `${symbol} 손절선 첫 터치 (${pnlPct.toFixed(2)}%) — 휩쏘 확인 시작 (5분 관찰)`);
        this._savePositions();
        return null;
      }

      // 터치 간 최소 간격 확인 (1분)
      const minInterval = STRATEGY.STOP_CONFIRM_MIN_INTERVAL || 60000;
      if (now - (pos.lastStopHitTime || 0) >= minInterval) {
        pos.stopHitCount = (pos.stopHitCount || 0) + 1;
        pos.lastStopHitTime = now;
        this._savePositions();
      }

      // 최소 관찰 시간 (5분) + 3회 터치 확인
      const minDuration = STRATEGY.STOP_CONFIRM_MIN_DURATION || 300000;
      const confirmNeeded = STRATEGY.STOP_CONFIRM_COUNT || 3;
      const elapsed = now - pos.firstStopHitTime;

      if (pos.stopHitCount >= confirmNeeded && elapsed >= minDuration) {
        const reason = pos.trailingActive
          ? `트레일링 스탑 (최고 ${((pos.highestPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)}% → ${pnlPct.toFixed(2)}%)`
          : pos.breakevenSet
            ? `브레이크이븐 청산 (${pnlPct.toFixed(2)}%)`
            : `손절 (${pnlPct.toFixed(2)}%, ${Math.round(elapsed/60000)}분 관찰)`;
        return { action: 'SELL', reason, pnlPct };
      }

      // 아직 확인 중
      if (pos.stopHitCount <= 2) {
        logger.info(TAG, `${symbol} 손절선 터치 ${pos.stopHitCount}/${confirmNeeded} (${pnlPct.toFixed(2)}%) — ${Math.round(elapsed/1000)}초/${Math.round(minDuration/1000)}초`);
      }
      return null;
    } else {
      // 가격이 손절선 위로 회복 → 전부 리셋 (휩쏘였음!)
      if (pos.stopHitCount > 0 || pos.firstStopHitTime) {
        const elapsed = pos.firstStopHitTime ? Math.round((Date.now() - pos.firstStopHitTime) / 1000) : 0;
        logger.info(TAG, `${symbol} 손절선 회복! 휩쏘 방지 성공 (${pos.stopHitCount || 0}회 터치, ${elapsed}초 후 반등)`);
        pos.stopHitCount = 0;
        pos.firstStopHitTime = null;
        pos.lastStopHitTime = null;
        pos.rsiProtectionLogged = false;
        this._savePositions();
      }
    }
    if (currentPrice >= pos.takeProfit) return { action: 'SELL', reason: `최종 익절 (${pnlPct.toFixed(2)}%)`, pnlPct };
    if (Date.now() >= pos.maxHoldTime) return { action: 'SELL', reason: `최대 보유시간 초과 (${pnlPct.toFixed(2)}%)`, pnlPct };

    // 절대 최대 보유시간 강제 종료
    const hardMax = STRATEGY.HARD_MAX_HOLD_HOURS || 8;
    if (holdHours >= hardMax) {
      return { action: 'SELL', reason: `강제 종료 ${hardMax}시간 초과 (${pnlPct.toFixed(2)}%)`, pnlPct, force: true };
    }

    // 2시간 보유 + 수익 없으면 조기 정리 (수수료 손해 방지)
    if (holdHours >= 2 && pnlPct > -0.3 && pnlPct < 0.5) {
      return { action: 'SELL', reason: `정체 포지션 조기 정리 (${holdHours.toFixed(1)}h, ${pnlPct.toFixed(2)}%)`, pnlPct };
    }

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

    // 연속 손실 추적
    if (pnlPct <= 0) {
      this.consecutiveLosses++;
      this.lastLossTime = Date.now();
    } else {
      this.consecutiveLosses = 0;
    }

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
   * DCA 물타기 가능 여부 체크
   * @param {string} symbol
   * @param {number} currentPrice
   * @returns {{ allowed: boolean, reason: string }}
   */
  canDCA(symbol, currentPrice, rsi = null) {
    const pos = this.positions.get(symbol);
    if (!pos) return { allowed: false, reason: '포지션 없음' };

    const triggerPct = STRATEGY.DCA_TRIGGER_PCT || -3.0;
    const maxCount = STRATEGY.DCA_MAX_COUNT || 1;
    const minInterval = STRATEGY.DCA_MIN_INTERVAL || 1800000;
    const rsiMax = STRATEGY.DCA_RSI_MAX || 35;
    const minHoldMin = STRATEGY.DCA_MIN_HOLD_MINUTES || 30;

    // 1. 현재 손실률 — 충분히 빠졌는지
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (pnlPct > triggerPct) {
      return { allowed: false, reason: `하락 부족 (${pnlPct.toFixed(2)}% > ${triggerPct}%)` };
    }

    // 2. DCA 횟수
    const dcaCount = pos.dcaCount || 0;
    if (dcaCount >= maxCount) {
      return { allowed: false, reason: `최대 DCA 횟수 도달 (${dcaCount}/${maxCount})` };
    }

    // 3. 최소 보유 시간 — 급매수 직후 물타기 방지
    const holdMin = (Date.now() - pos.entryTime) / 60000;
    if (holdMin < minHoldMin) {
      return { allowed: false, reason: `보유시간 부족 (${Math.round(holdMin)}분 < ${minHoldMin}분)` };
    }

    // 4. RSI 과매도 확인 — 반등 가능성 있을 때만
    if (rsi != null && rsi > rsiMax) {
      return { allowed: false, reason: `RSI 과매도 아님 (${rsi.toFixed(1)} > ${rsiMax})` };
    }

    // 5. DCA 간격
    if (pos.lastDcaTime && Date.now() - pos.lastDcaTime < minInterval) {
      const remain = Math.ceil((minInterval - (Date.now() - pos.lastDcaTime)) / 1000);
      return { allowed: false, reason: `DCA 간격 대기 (${remain}초)` };
    }

    // 6. 손절선 근접 시 DCA 금지 (물타기해도 곧 손절됨)
    const stopDist = ((pos.stopLoss - currentPrice) / currentPrice) * 100;
    if (stopDist > -0.5) {
      return { allowed: false, reason: `손절선 근접 → DCA 무의미` };
    }

    return { allowed: true, reason: `DCA ${dcaCount + 1}차 조건 충족 (${pnlPct.toFixed(2)}%, RSI ${rsi ? rsi.toFixed(0) : '?'})` };
  }

  /**
   * DCA 물타기 실행: 포지션 업데이트
   * @param {string} symbol
   * @param {number} price - 추가 매수 가격
   * @param {number} quantity - 추가 매수 수량
   * @param {number} amount - 추가 매수 금액 (KRW)
   */
  executeDCA(symbol, price, quantity, amount) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const totalQty = pos.quantity + quantity;
    const totalAmount = pos.amount + amount;
    const newAvgPrice = totalAmount / totalQty;

    // 평균매수가 재계산
    pos.entryPrice = newAvgPrice;
    pos.quantity = totalQty;
    pos.amount = totalAmount;

    // 손절/익절선 재계산 (새 평균가 기준)
    pos.stopLoss = newAvgPrice * (1 + STRATEGY.STOP_LOSS_PCT / 100);
    pos.takeProfit = newAvgPrice * (1 + STRATEGY.TAKE_PROFIT_PCT / 100);
    pos.highestPrice = Math.max(pos.highestPrice || newAvgPrice, price);

    // DCA 카운트 및 시간 업데이트
    pos.dcaCount = (pos.dcaCount || 0) + 1;
    pos.lastDcaTime = Date.now();

    // 휩쏘 방지 카운터 리셋 (DCA 후 새 기준으로)
    pos.stopHitCount = 0;
    pos.firstStopHitTime = null;
    pos.lastStopHitTime = null;
    pos.breakevenSet = false;
    pos.trailingActive = false;

    logger.info(TAG, `DCA 물타기 완료: ${symbol}`, {
      newAvgPrice: Math.round(newAvgPrice), totalQty: totalQty.toFixed(6),
      dcaCount: pos.dcaCount, newSL: Math.round(pos.stopLoss), newTP: Math.round(pos.takeProfit),
    });

    this._savePositions();
    return { avgPrice: newAvgPrice, totalQty, dcaCount: pos.dcaCount };
  }

  /**
   * 분할매도 체크: 수익률 단계별 분할매도
   * 1차: +2% → 40% 매도 (빠른 수익 확보)
   * 2차: +4% → 40% 추가 매도
   * 나머지 20%는 트레일링 스탑으로 최대한 먹기
   */
  checkPartialExit(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const partialSells = pos.partialSells || 0;

    const p1Pct = STRATEGY.PARTIAL_1_PCT || 2.0;
    const p1Frac = STRATEGY.PARTIAL_1_FRAC || 0.4;
    const p2Pct = STRATEGY.PARTIAL_2_PCT || 4.0;
    const p2Frac = STRATEGY.PARTIAL_2_FRAC || 0.4;

    if (partialSells === 0 && pnlPct >= p1Pct) {
      return { shouldPartialSell: true, fraction: p1Frac, reason: `1차 분할익절 (+${pnlPct.toFixed(1)}%)`, pnlPct };
    }
    if (partialSells === 1 && pnlPct >= p2Pct) {
      return { shouldPartialSell: true, fraction: p2Frac, reason: `2차 분할익절 (+${pnlPct.toFixed(1)}%)`, pnlPct };
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

  /**
   * 매도 실패 횟수 기록 → 10회 실패시 강제 포지션 정리
   */
  recordSellFailure(symbol) {
    const pos = this.positions.get(symbol);
    if (!pos) return false;
    pos.sellAttempts = (pos.sellAttempts || 0) + 1;
    if (pos.sellAttempts >= 10) {
      logger.warn(TAG, `${symbol} 매도 10회 연속 실패 → 포지션 강제 제거 (거래소에서 수동 확인 필요)`);
      this.positions.delete(symbol);
      this._savePositions();
      return true; // 강제 제거됨
    }
    this._savePositions();
    return false;
  }

  getPositions() {
    return Object.fromEntries(this.positions);
  }

  getDailyPnl() {
    return this.dailyPnl;
  }
}

module.exports = { RiskManager };
