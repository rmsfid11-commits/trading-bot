/**
 * 그리드 트레이딩 모듈
 *
 * 횡보장에서 일정 가격 간격으로 매수/매도
 * 레짐이 'ranging'일 때만 활성화
 *
 * 동작 방식:
 * - 현재가를 중심으로 상하 N단계 그리드 생성
 * - 가격이 매수 레벨(중심 하방) 하향 돌파 시 매수
 * - 가격이 매도 레벨(중심 상방) 상향 돌파 시 대응 매수분 매도
 * - 각 그리드 쌍 = 1 라운드트립 수익
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = 'grid-state.json';

class GridTrader {
  /**
   * @param {string|null} logDir - 상태 파일 저장 경로
   */
  constructor(logDir = null) {
    this.logDir = logDir || path.join(__dirname, '../../logs');
    this.grids = {}; // symbol -> { center, levels, createdAt }
    this.stats = { totalRoundTrips: 0, totalProfit: 0 };
    this._load();
  }

  /**
   * 그리드 초기화 (심볼, 현재가, 잔고)
   * 현재가를 중심으로 상하 GRID_LEVELS 단계 생성
   *
   * @param {string} symbol
   * @param {number} currentPrice
   * @param {number} balance - 사용 가능 잔고 (KRW)
   * @param {Object} opts - { levels, spacingPct, amountPct }
   * @returns {Object} 생성된 그리드 정보
   */
  setupGrid(symbol, currentPrice, balance, opts = {}) {
    const {
      levels = 3,
      spacingPct = 0.8,
      amountPct = 5,
    } = opts;

    const spacing = currentPrice * (spacingPct / 100);
    const amountPerLevel = Math.floor(balance * (amountPct / 100));

    // 매수 레벨: 중심 아래 (level -1, -2, -3)
    // 매도 레벨: 중심 위 (level +1, +2, +3)
    const gridLevels = [];

    for (let i = levels; i >= 1; i--) {
      gridLevels.push({
        index: -i,
        price: Math.round(currentPrice - spacing * i),
        type: 'BUY',
        filled: false,
        fillPrice: null,
        fillTime: null,
        quantity: 0,
        amount: amountPerLevel,
      });
    }

    // 중심 (참고용, 매매 안 함)
    gridLevels.push({
      index: 0,
      price: Math.round(currentPrice),
      type: 'CENTER',
      filled: false,
      fillPrice: null,
      fillTime: null,
      quantity: 0,
      amount: 0,
    });

    for (let i = 1; i <= levels; i++) {
      gridLevels.push({
        index: i,
        price: Math.round(currentPrice + spacing * i),
        type: 'SELL',
        filled: false,
        fillPrice: null,
        fillTime: null,
        quantity: 0,
        amount: amountPerLevel,
      });
    }

    this.grids[symbol] = {
      center: Math.round(currentPrice),
      levels: gridLevels,
      spacingPct,
      amountPerLevel,
      createdAt: Date.now(),
      lastCheckPrice: currentPrice,
      roundTrips: 0,
      profit: 0,
    };

    this._save();
    return this.grids[symbol];
  }

  /**
   * 현재가로 그리드 시그널 체크
   * - 가격이 매수 레벨을 하향 돌파하면 BUY
   * - 가격이 매도 레벨을 상향 돌파하고, 대응 매수가 체결된 상태면 SELL
   *
   * @param {string} symbol
   * @param {number} currentPrice
   * @returns {{ action: string|null, level: number|null, price: number|null, amount: number|null, targetLevel: Object|null }}
   */
  checkGrid(symbol, currentPrice) {
    const grid = this.grids[symbol];
    if (!grid) return { action: null, level: null, price: null, amount: null };

    const lastPrice = grid.lastCheckPrice || currentPrice;
    let result = { action: null, level: null, price: null, amount: null, targetLevel: null };

    // 매수 체크: 가격이 매수 레벨을 하향 돌파
    const buyLevels = grid.levels
      .filter(l => l.type === 'BUY' && !l.filled)
      .sort((a, b) => b.price - a.price); // 높은 레벨부터 (가까운 것 우선)

    for (const level of buyLevels) {
      if (currentPrice <= level.price && lastPrice > level.price) {
        result = {
          action: 'BUY',
          level: level.index,
          price: level.price,
          amount: level.amount,
          targetLevel: level,
        };
        break;
      }
    }

    // 매도 체크: 가격이 매도 레벨을 상향 돌파 + 대응 매수가 체결된 상태
    if (!result.action) {
      const sellLevels = grid.levels
        .filter(l => l.type === 'SELL' && !l.filled)
        .sort((a, b) => a.price - b.price); // 낮은 레벨부터 (가까운 것 우선)

      for (const sellLevel of sellLevels) {
        if (currentPrice >= sellLevel.price && lastPrice < sellLevel.price) {
          // 대응 매수 레벨이 체결된 상태인지 확인
          const buyPair = grid.levels.find(
            l => l.type === 'BUY' && l.index === -sellLevel.index && l.filled
          );
          if (buyPair) {
            result = {
              action: 'SELL',
              level: sellLevel.index,
              price: sellLevel.price,
              amount: Math.round(buyPair.quantity * sellLevel.price),
              quantity: buyPair.quantity,
              targetLevel: sellLevel,
              buyPairLevel: buyPair,
            };
            break;
          }
        }
      }
    }

    // 마지막 체크 가격 업데이트
    grid.lastCheckPrice = currentPrice;
    this._save();

    return result;
  }

  /**
   * 그리드 매수/매도 실행 후 상태 업데이트
   *
   * @param {string} symbol
   * @param {number} levelIndex - 체결된 레벨 인덱스
   * @param {string} action - 'BUY' | 'SELL'
   * @param {number} price - 실제 체결 가격
   * @param {number} quantity - 체결 수량
   */
  recordFill(symbol, levelIndex, action, price, quantity) {
    const grid = this.grids[symbol];
    if (!grid) return;

    const level = grid.levels.find(l => l.index === levelIndex);
    if (!level) return;

    if (action === 'BUY') {
      level.filled = true;
      level.fillPrice = price;
      level.fillTime = Date.now();
      level.quantity = quantity;
    } else if (action === 'SELL') {
      level.filled = true;
      level.fillPrice = price;
      level.fillTime = Date.now();

      // 대응 매수 레벨도 리셋 (라운드트립 완료)
      const buyPair = grid.levels.find(
        l => l.type === 'BUY' && l.index === -levelIndex && l.filled
      );
      if (buyPair) {
        const profit = (price - buyPair.fillPrice) * buyPair.quantity;
        grid.roundTrips++;
        grid.profit += profit;
        this.stats.totalRoundTrips++;
        this.stats.totalProfit += profit;

        // 라운드트립 완료 후 양쪽 레벨 리셋 (재사용)
        buyPair.filled = false;
        buyPair.fillPrice = null;
        buyPair.fillTime = null;
        buyPair.quantity = 0;

        level.filled = false;
        level.fillPrice = null;
        level.fillTime = null;
      }
    }

    this._save();
  }

  /**
   * 그리드 상태 조회
   * @returns {Object} 전체 그리드 상태
   */
  getGridStatus() {
    const status = {
      activeGrids: {},
      stats: { ...this.stats },
    };

    for (const [symbol, grid] of Object.entries(this.grids)) {
      const buyLevels = grid.levels.filter(l => l.type === 'BUY');
      const sellLevels = grid.levels.filter(l => l.type === 'SELL');
      const filledBuys = buyLevels.filter(l => l.filled).length;
      const filledSells = sellLevels.filter(l => l.filled).length;

      status.activeGrids[symbol] = {
        center: grid.center,
        spacingPct: grid.spacingPct,
        amountPerLevel: grid.amountPerLevel,
        buyLevels: buyLevels.length,
        filledBuys,
        sellLevels: sellLevels.length,
        filledSells,
        roundTrips: grid.roundTrips,
        profit: Math.round(grid.profit),
        createdAt: grid.createdAt,
        levels: grid.levels.map(l => ({
          index: l.index,
          price: l.price,
          type: l.type,
          filled: l.filled,
        })),
      };
    }

    return status;
  }

  /**
   * 특정 심볼 그리드 존재 여부
   * @param {string} symbol
   * @returns {boolean}
   */
  hasGrid(symbol) {
    return !!this.grids[symbol];
  }

  /**
   * 그리드 초기화 (레짐 변경 시)
   * @param {string} symbol
   */
  resetGrid(symbol) {
    if (this.grids[symbol]) {
      // 미체결 매수가 있으면 경고 로그용 데이터 반환
      const grid = this.grids[symbol];
      const filledBuys = grid.levels.filter(l => l.type === 'BUY' && l.filled);
      delete this.grids[symbol];
      this._save();
      return { hadFilledBuys: filledBuys.length > 0, filledBuys };
    }
    return { hadFilledBuys: false, filledBuys: [] };
  }

  /**
   * 모든 그리드 초기화
   */
  resetAll() {
    const symbols = Object.keys(this.grids);
    this.grids = {};
    this._save();
    return symbols;
  }

  /**
   * 그리드에서 체결된 매수 중 아직 매도되지 않은 것들의 심볼/수량 반환
   * (봇 종료 시 잔여 포지션 정리용)
   */
  getOpenGridPositions() {
    const positions = [];
    for (const [symbol, grid] of Object.entries(this.grids)) {
      const filledBuys = grid.levels.filter(l => l.type === 'BUY' && l.filled);
      for (const buy of filledBuys) {
        positions.push({
          symbol,
          level: buy.index,
          price: buy.fillPrice,
          quantity: buy.quantity,
        });
      }
    }
    return positions;
  }

  /**
   * 상태 저장
   */
  _save() {
    try {
      const filePath = path.join(this.logDir, STATE_FILE);
      const data = {
        grids: this.grids,
        stats: this.stats,
        savedAt: Date.now(),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      // 저장 실패해도 계속 동작
    }
  }

  /**
   * 상태 로드
   */
  _load() {
    try {
      const filePath = path.join(this.logDir, STATE_FILE);
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.grids) this.grids = data.grids;
      if (data.stats) this.stats = data.stats;
    } catch (err) {
      // 로드 실패 시 빈 상태로 시작
      this.grids = {};
      this.stats = { totalRoundTrips: 0, totalProfit: 0 };
    }
  }
}

module.exports = { GridTrader };
