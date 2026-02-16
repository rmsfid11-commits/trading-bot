/**
 * 호가창(오더북) 분석
 *
 * 매수/매도 벽 감지, 스프레드 분석, 매수/매도 압력 계산
 * Upbit ccxt fetchOrderBook 사용
 */

/**
 * 오더북 분석
 * @param {Object} orderbook - ccxt fetchOrderBook 결과 { bids: [[price, amount]], asks: [[price, amount]] }
 * @param {number} currentPrice - 현재가
 * @returns {{ buyPressure, sellPressure, imbalance, spread, walls, score }}
 */
function analyzeOrderbook(orderbook, currentPrice) {
  if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
    return { buyPressure: 0, sellPressure: 0, imbalance: 0, spread: 0, walls: [], score: 0 };
  }

  const bids = orderbook.bids.slice(0, 15); // 매수 호가 상위 15개
  const asks = orderbook.asks.slice(0, 15); // 매도 호가 상위 15개

  // 매수/매도 총량 (가격 × 수량 = KRW 기준)
  const bidTotal = bids.reduce((s, [price, amount]) => s + price * amount, 0);
  const askTotal = asks.reduce((s, [price, amount]) => s + price * amount, 0);

  // 매수 압력 (0 ~ 100)
  const total = bidTotal + askTotal;
  const buyPressure = total > 0 ? Math.round((bidTotal / total) * 100) : 50;
  const sellPressure = 100 - buyPressure;

  // 불균형 (-100 ~ +100): 양수 = 매수 우세, 음수 = 매도 우세
  const imbalance = total > 0 ? Math.round(((bidTotal - askTotal) / total) * 100) : 0;

  // 스프레드 (%)
  const bestBid = bids[0]?.[0] || 0;
  const bestAsk = asks[0]?.[0] || 0;
  const spread = bestBid > 0 ? Math.round(((bestAsk - bestBid) / bestBid) * 10000) / 100 : 0;

  // 벽 감지: 평균 대비 3배 이상 큰 주문
  const bidAvg = bids.reduce((s, [, a]) => s + a, 0) / bids.length;
  const askAvg = asks.reduce((s, [, a]) => s + a, 0) / asks.length;
  const walls = [];

  for (const [price, amount] of bids) {
    if (amount > bidAvg * 3) {
      const distPct = ((currentPrice - price) / currentPrice) * 100;
      walls.push({ type: 'BID', price, amount, distPct: Math.round(distPct * 100) / 100, strength: Math.round(amount / bidAvg * 10) / 10 });
    }
  }
  for (const [price, amount] of asks) {
    if (amount > askAvg * 3) {
      const distPct = ((price - currentPrice) / currentPrice) * 100;
      walls.push({ type: 'ASK', price, amount, distPct: Math.round(distPct * 100) / 100, strength: Math.round(amount / askAvg * 10) / 10 });
    }
  }

  // 가까운 벽(1% 이내) 점수 영향
  const nearBidWalls = walls.filter(w => w.type === 'BID' && w.distPct < 1);
  const nearAskWalls = walls.filter(w => w.type === 'ASK' && w.distPct < 1);

  // 종합 점수 (-2 ~ +2): 양수 = 매수 유리, 음수 = 매도 유리
  let score = 0;

  // 불균형 기반 (매수 우세면 +)
  if (imbalance > 20) score += 0.5;
  else if (imbalance > 40) score += 1.0;
  else if (imbalance < -20) score -= 0.5;
  else if (imbalance < -40) score -= 1.0;

  // 가까운 매수벽 = 지지, 매도벽 = 저항
  if (nearBidWalls.length > 0) score += 0.3 * nearBidWalls.length;
  if (nearAskWalls.length > 0) score -= 0.3 * nearAskWalls.length;

  // 스프레드가 좁으면 유동성 좋음
  if (spread < 0.05) score += 0.2;
  if (spread > 0.3) score -= 0.3;

  score = Math.max(-2, Math.min(2, Math.round(score * 100) / 100));

  // 고래벽 감지 (평균 대비 5배 이상 & 1% 이내)
  const whaleWalls = walls.filter(w => w.strength >= 5 && w.distPct < 1.0);

  return {
    buyPressure,
    sellPressure,
    imbalance,
    spread,
    walls: walls.slice(0, 6), // 상위 6개만
    whaleWalls,
    score,
    bidTotal: Math.round(bidTotal),
    askTotal: Math.round(askTotal),
  };
}

/**
 * 고래벽 시그널: 큰 매수벽은 지지, 큰 매도벽은 저항
 * @param {Object} obResult - analyzeOrderbook 결과
 * @returns {{ buyBoost, sellBoost, whaleInfo }}
 */
function getWhaleWallSignal(obResult) {
  if (!obResult?.whaleWalls?.length) {
    return { buyBoost: 0, sellBoost: 0, whaleInfo: null };
  }

  let buyBoost = 0;
  let sellBoost = 0;
  const info = [];

  for (const w of obResult.whaleWalls) {
    const strengthBonus = Math.min(1.0, (w.strength - 5) * 0.2); // 5x→0, 10x→1.0

    if (w.type === 'BID') {
      // 큰 매수벽 = 강한 지지 → 매수 유리
      buyBoost += 0.5 + strengthBonus;
      info.push(`매수벽 ${w.price.toLocaleString()} (${w.strength}x, -${w.distPct}%)`);
    } else {
      // 큰 매도벽 = 강한 저항 → 상승 제한
      sellBoost += 0.3 + strengthBonus;
      info.push(`매도벽 ${w.price.toLocaleString()} (${w.strength}x, +${w.distPct}%)`);
    }
  }

  return {
    buyBoost: Math.round(Math.min(2.0, buyBoost) * 100) / 100,
    sellBoost: Math.round(Math.min(2.0, sellBoost) * 100) / 100,
    whaleInfo: info.length > 0 ? info.join(', ') : null,
  };
}

module.exports = { analyzeOrderbook, getWhaleWallSignal };
