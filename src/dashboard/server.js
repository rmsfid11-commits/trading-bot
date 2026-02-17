const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { logger } = require('../logger/trade-logger');
const { loadLearnedParams } = require('../learning/analyzer');
const { getAllComboStats, getOptimalMinBuyScore } = require('../learning/combo-tracker');
const { loadBacktestResults } = require('../learning/backtest');
const { STRATEGY } = require('../config/strategy');
const { USERS_DIR, listUsers, getUserConfig, LOGS_BASE } = require('../config/users');
const { getCachedWhaleAlerts } = require('../indicators/whale-alert');
const { DashboardChatbot } = require('./chatbot');

const TAG = 'DASH';
const DEFAULT_PORT = 3737;
const MAX_HISTORY = 60;
const MAX_LOGS = 100;
const MAX_PNL_HISTORY = 120;

class DashboardServer {
  constructor(bot, port = DEFAULT_PORT, options = {}) {
    this.bot = bot;
    this.port = port;
    this.logDir = options.logDir || path.join(__dirname, '../../logs');
    this.onUserRegistered = options.onUserRegistered || null;
    this.wss = null;
    this.server = null;
    this.broadcastInterval = null;
    this.priceHistory = {};
    this.currentPrices = {};
    this.pnlHistory = []; // { time, pnl } (5초 간격, 히어로 스파크라인용)
    this.pnlMinuteData = []; // { time, realized, unrealized, total } (1분 간격, 차트용)
    this._lastMinuteCapture = 0;
    this.logBuffer = []; // recent log messages
    this.lastSignals = {}; // { symbol: { rsi, bollinger, volume, action } }

    // 잔고 캐시 (5초마다 갱신)
    this.cachedBalance = { free: 0, totalAsset: 0, investedCost: 0, investedCurrent: 0, lastUpdate: 0 };

    // AI 챗봇 (ANTHROPIC_API_KEY 있을 때만)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    this.chatbot = anthropicKey ? new DashboardChatbot(anthropicKey, bot) : null;
    if (this.chatbot) logger.info(TAG, 'AI 챗봇 활성화');

    // 분 단위 PnL 데이터 로드
    this._loadPnlMinuteData();

    // Hook into logger to capture logs
    this._hookLogger();
  }

  _hookLogger() {
    const origLog = logger.info;
    const origWarn = logger.warn;
    const origError = logger.error;
    const origTrade = logger.trade;
    const self = this;

    const capture = (level, origFn) => (tag, msg, data) => {
      origFn.call(logger, tag, msg, data);
      self._addLog(level, tag, msg);
    };

    logger.info = capture('INFO', origLog);
    logger.warn = capture('WARN', origWarn);
    logger.error = capture('ERROR', origError);
    logger.trade = capture('TRADE', origTrade);

    // Hook logTrade for real-time trade events (기본 로거)
    const origLogTrade = logger.logTrade.bind(logger);
    logger.logTrade = (trade) => {
      origLogTrade(trade);
      self._broadcastTrade(trade);
    };

    // 봇의 유저별 로거도 후킹 (trades.jsonl이 유저 디렉토리에 기록됨)
    if (this.bot.logger && this.bot.logger !== logger) {
      const botLogger = this.bot.logger;
      const origBotLogTrade = botLogger.logTrade.bind(botLogger);
      botLogger.logTrade = (trade) => {
        origBotLogTrade(trade);
        self._broadcastTrade(trade);
      };
      // 봇 로거의 일반 로그도 캡처
      const origBotInfo = botLogger.info;
      const origBotWarn = botLogger.warn;
      const origBotError = botLogger.error;
      const origBotTrade = botLogger.trade;
      const captureBot = (level, origFn) => (tag, msg, data) => {
        origFn.call(botLogger, tag, msg, data);
        self._addLog(level, tag, msg);
      };
      botLogger.info = captureBot('INFO', origBotInfo);
      botLogger.warn = captureBot('WARN', origBotWarn);
      botLogger.error = captureBot('ERROR', origBotError);
      botLogger.trade = captureBot('TRADE', origBotTrade);
    }
  }

  _addLog(level, tag, msg) {
    const entry = { time: Date.now(), level, tag, msg };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > MAX_LOGS) this.logBuffer = this.logBuffer.slice(-MAX_LOGS);
    // Broadcast log
    this._broadcast({ type: 'log', data: entry });
  }

  _broadcastTrade(trade) {
    this._broadcast({ type: 'trade_event', data: { ...trade, timestamp: Date.now() } });
  }

  _broadcast(msg) {
    if (!this.wss) return;
    const str = JSON.stringify(msg);
    this.wss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
      } else if (req.url === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
        res.end(fs.readFileSync(path.join(__dirname, 'manifest.json')));
      } else if (req.url === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
        res.end(`
const CACHE = 'trading-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('ws')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && e.request.method === 'GET') {
        const c = r.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, c));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
`);
      } else if (req.url === '/icon-192.svg' || req.url === '/icon-512.svg') {
        const size = req.url.includes('192') ? 192 : 512;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        res.end(this._generateIcon(size));
      } else if (req.url === '/icon-192.png' || req.url === '/icon-512.png') {
        const size = req.url.includes('192') ? 192 : 512;
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(this._generatePngIcon(size));
      } else if (req.url.startsWith('/api/pnl-history')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const tf = urlObj.searchParams.get('tf') || '1d';
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getPnlHistoryByTf(tf)));
      } else if (req.url === '/api/blacklist' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getBlacklist()));
      } else if (req.url === '/api/blacklist' && req.method === 'POST') {
        this._handleBlacklist(req, res);
        return;
      } else if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getStatus()));
      } else if (req.url === '/api/trades') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.getRecentTrades()));
      } else if (req.url === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this.logBuffer.slice(-30)));
      } else if (req.url.startsWith('/api/candles/')) {
        const symbol = decodeURIComponent(req.url.replace('/api/candles/', ''));
        this.handleCandles(symbol, res);
        return;
      } else if (req.url === '/register') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(fs.readFileSync(path.join(__dirname, 'register.html')));
      } else if (req.url === '/api/register' && req.method === 'POST') {
        this._handleRegister(req, res);
        return;
      } else if (req.url === '/api/users' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ users: listUsers() }));
      } else if (req.url === '/api/chat' && req.method === 'POST') {
        this._handleChat(req, res);
        return;
      } else if (req.url === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
      } else if (req.url === '/api/admin/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(this._getAdminStatus()));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      logger.info(TAG, '대시보드 클라이언트 연결');
      try {
        ws.send(JSON.stringify({ type: 'status', data: this.getStatus() }));
        ws.send(JSON.stringify({ type: 'trades', data: this.getRecentTrades() }));
        ws.send(JSON.stringify({ type: 'logs', data: this.logBuffer.slice(-30) }));
      } catch (e) {
        logger.error(TAG, `대시보드 초기 데이터 전송 실패: ${e.message}`);
      }

      // WebSocket 명령 수신
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.command === 'run_learning') {
            this._handleRunLearning(ws);
          } else if (msg.command === 'run_backtest') {
            this._handleRunBacktest(ws, msg.symbols);
          }
        } catch { }
      });
    });

    this.broadcastInterval = setInterval(async () => {
      try {
        await this.updatePrices();
        this._captureSignals();
        this._capturePnl();
        const msg = JSON.stringify({ type: 'status', data: this.getStatus() });
        this.wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
      } catch (e) {
        logger.error(TAG, `대시보드 브로드캐스트 실패: ${e.message}`);
      }
    }, 3000);

    this.server.listen(this.port, () => {
      logger.info(TAG, `대시보드: http://localhost:${this.port}`);
    });
  }

  async updatePrices() {
    const now = Date.now();
    // 하이브리드: 캐시 3초 이내 → 재사용 (API 0), 넘으면 벌크 1회
    const cacheAge = now - (this.bot._tickerCacheTime || 0);
    let tickers = cacheAge < 3000 ? this.bot._tickerCache : null;
    if (!tickers) {
      try {
        tickers = await this.bot.exchange.getAllTickers(this.bot.symbols);
        if (tickers) {
          this.bot._tickerCache = tickers;
          this.bot._tickerCacheTime = now;
        }
      } catch { }
    }
    if (tickers) {
      for (const symbol of this.bot.symbols) {
        const ticker = tickers[symbol];
        if (!ticker) continue;
        this.currentPrices[symbol] = ticker.price;
        if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
        this.priceHistory[symbol].push({ time: now, price: ticker.price, change: ticker.change });
        if (this.priceHistory[symbol].length > MAX_HISTORY)
          this.priceHistory[symbol] = this.priceHistory[symbol].slice(-MAX_HISTORY);
      }
    }

    // 잔고 갱신 (API 1회)
    try {
      const bal = await this.bot.exchange.getBalance();
      const positions = this.bot.risk.getPositions();
      let investedCost = 0;
      let investedCurrent = 0;
      for (const [symbol, pos] of Object.entries(positions)) {
        investedCost += pos.amount || 0;
        const cur = this.currentPrices[symbol] || pos.entryPrice;
        investedCurrent += cur * pos.quantity;
      }
      const freeKRW = bal ? bal.free : 0;
      this.cachedBalance = {
        free: Math.round(freeKRW),
        totalAsset: Math.round(freeKRW + investedCurrent),
        investedCost: Math.round(investedCost),
        investedCurrent: Math.round(investedCurrent),
        lastUpdate: now,
      };
    } catch { }
  }

  _captureSignals() {
    if (this.bot.lastSignals) {
      this.lastSignals = { ...this.bot.lastSignals };
    }
  }

  _capturePnl() {
    const pnl = this.bot.risk.getDailyPnl();
    // Also add unrealized PnL from open positions
    let unrealized = 0;
    const positions = this.bot.risk.getPositions();
    for (const [symbol, pos] of Object.entries(positions)) {
      const cur = this.currentPrices[symbol];
      if (cur) unrealized += (cur - pos.entryPrice) * pos.quantity;
    }
    const now = Date.now();
    this.pnlHistory.push({ time: now, realized: Math.round(pnl), unrealized: Math.round(unrealized), total: Math.round(pnl + unrealized) });
    if (this.pnlHistory.length > MAX_PNL_HISTORY) this.pnlHistory = this.pnlHistory.slice(-MAX_PNL_HISTORY);

    // 1분 간격 캡처 (차트용, 최대 2880개 = 48시간)
    if (now - this._lastMinuteCapture >= 60000) {
      this._lastMinuteCapture = now;
      this.pnlMinuteData.push({ time: now, realized: Math.round(pnl), unrealized: Math.round(unrealized), total: Math.round(pnl + unrealized) });
      if (this.pnlMinuteData.length > 2880) this.pnlMinuteData = this.pnlMinuteData.slice(-2880);
      // 10분마다 디스크에 저장
      if (this.pnlMinuteData.length % 10 === 0) this._savePnlMinuteData();
    }
  }

  _loadPnlMinuteData() {
    try {
      const filePath = path.join(this.logDir, 'pnl-minutes.json');
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // 48시간 이내 데이터만 유지
        const cutoff = Date.now() - 48 * 3600000;
        this.pnlMinuteData = (data || []).filter(d => d.time > cutoff);
      }
    } catch { }
    // trades.jsonl에서 과거 거래 데이터 백필 (항상 실행, 머지)
    this._backfillFromTrades();
  }

  /**
   * trades.jsonl에서 과거 데이터를 백필하여 차트 즉시 표시
   * SELL 거래의 누적 실현손익을 시간순으로 만든다
   */
  _backfillFromTrades() {
    try {
      const tradePath = path.join(this.logDir, 'trades.jsonl');
      if (!fs.existsSync(tradePath)) return;
      const lines = fs.readFileSync(tradePath, 'utf-8').trim().split('\n').filter(Boolean);
      const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const sells = trades.filter(t => t.action === 'SELL' && t.pnl != null && t.timestamp);
      if (sells.length === 0) return;

      sells.sort((a, b) => a.timestamp - b.timestamp);
      let cumRealized = 0;
      const points = [];

      for (const t of sells) {
        const pnlAmt = t.pnlAmount != null ? t.pnlAmount : (t.amount ? t.amount * t.pnl / 100 : t.pnl);
        cumRealized += pnlAmt;
        points.push({ time: t.timestamp, realized: Math.round(cumRealized), unrealized: 0, total: Math.round(cumRealized) });
      }

      // 기존 스냅샷과 머지 (시간순, 중복 제거)
      const existing = new Set(this.pnlMinuteData.map(d => d.time));
      const merged = [...this.pnlMinuteData];
      for (const p of points) {
        if (!existing.has(p.time)) merged.push(p);
      }
      merged.sort((a, b) => a.time - b.time);
      // 최대 2880개 유지
      this.pnlMinuteData = merged.slice(-2880);
      logger.info(TAG, `PnL 백필 완료: trades.jsonl에서 ${points.length}개 포인트 추가 (총 ${this.pnlMinuteData.length}개)`);
    } catch (e) {
      logger.error(TAG, `PnL 백필 실패: ${e.message}`);
    }
  }

  _savePnlMinuteData() {
    try {
      const filePath = path.join(this.logDir, 'pnl-minutes.json');
      fs.writeFileSync(filePath, JSON.stringify(this.pnlMinuteData));
    } catch { }
  }

  getStatus() {
    const positions = this.bot.risk.getPositions();
    const posEntries = Object.entries(positions).map(([symbol, pos]) => {
      const curPrice = this.currentPrices[symbol] || pos.entryPrice;
      const pnlPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;
      return {
        symbol, entryPrice: pos.entryPrice, currentPrice: curPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        stopLoss: Math.round(pos.stopLoss), takeProfit: Math.round(pos.takeProfit),
        holdMinutes: Math.round((Date.now() - pos.entryTime) / 60000),
        amount: pos.amount,
        dcaCount: pos.dcaCount || 0,
        partialSells: pos.partialSells || 0,
        breakevenSet: !!pos.breakevenSet,
        trailingActive: !!pos.trailingActive,
        scalpMode: !!pos.scalpMode,
        highestPnlPct: pos.highestPrice ? Math.round(((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100 : 0,
      };
    });

    const symbolData = this.bot.symbols.map(symbol => {
      const history = this.priceHistory[symbol] || [];
      const prices = history.map(h => h.price);
      const curPrice = this.currentPrices[symbol] || null;
      const change = history.length > 0 ? history[history.length - 1].change : null;
      const sig = this.lastSignals[symbol];
      const indicators = sig?.indicators || null;
      const action = sig?.action || 'HOLD';
      const patterns = sig?.patterns || null;
      const mtf = sig?.mtf || null;
      const scores = sig?.scores || null;
      const symSentiment = sig?.sentiment || null;
      const orderbook = sig?.orderbook || 0;
      return { symbol, price: curPrice, change, sparkline: prices, indicators, action, patterns, mtf, scores, sentiment: symSentiment, orderbook };
    });

    // Trade stats — 전체 + 오늘 매매 통계
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const allTrades = this.getRecentTrades();
    const todayTrades = allTrades.filter(t => t.timestamp >= todayMs);
    const todayBuys = todayTrades.filter(t => t.action === 'BUY');

    // 전체 누적 통계 (최근 50건 기준)
    const allSells = allTrades.filter(t => t.action === 'SELL' && t.pnl != null);
    const allWins = allSells.filter(t => t.pnl > 0);
    const allLosses = allSells.filter(t => t.pnl <= 0);
    const allAvgPnl = allSells.length > 0 ? allSells.reduce((s, t) => s + t.pnl, 0) / allSells.length : 0;
    const bestTrade = allSells.length > 0 ? allSells.reduce((b, t) => t.pnl > b.pnl ? t : b, allSells[0]) : null;
    const worstTrade = allSells.length > 0 ? allSells.reduce((w, t) => t.pnl < w.pnl ? t : w, allSells[0]) : null;

    // 오늘 통계
    const todaySells = todayTrades.filter(t => t.action === 'SELL' && t.pnl != null);
    const todayWins = todaySells.filter(t => t.pnl > 0);
    const todayLosses = todaySells.filter(t => t.pnl <= 0);

    // 실현 손익 (원화) — 오늘 + 전체
    const calcPnlAmount = (t) => t.pnlAmount != null ? t.pnlAmount : (t.amount ? t.amount * t.pnl / 100 : t.pnl);
    const todayRealizedPnl = Math.round(todaySells.reduce((s, t) => s + calcPnlAmount(t), 0));
    const totalRealizedPnl = Math.round(allSells.reduce((s, t) => s + calcPnlAmount(t), 0));

    // 미실현 손익 (현재 보유 포지션 평가)
    let todayUnrealizedPnl = 0;
    for (const [symbol, pos] of Object.entries(positions)) {
      const cur = this.currentPrices[symbol] || pos.entryPrice;
      todayUnrealizedPnl += (cur - pos.entryPrice) * pos.quantity;
    }
    todayUnrealizedPnl = Math.round(todayUnrealizedPnl);

    // 오늘 평균 수익률
    const todayAvgPnl = todaySells.length > 0 ? Math.round(todaySells.reduce((s, t) => s + t.pnl, 0) / todaySells.length * 100) / 100 : 0;

    // 학습 데이터
    const learned = this.bot.learnedData || loadLearnedParams();
    const learningData = learned ? {
      updatedAt: learned.updatedAt,
      tradesAnalyzed: learned.tradesAnalyzed || 0,
      confidence: learned.confidence || 0,
      blacklist: learned.blacklist || [],
      preferredHours: learned.preferredHours || [],
      avoidHours: learned.avoidHours || [],
      symbolScores: learned.symbolScores || {},
      params: learned.params || null,
      analysis: learned.analysis ? {
        bySymbol: learned.analysis.bySymbol || {},
        byHour: learned.analysis.byHour || {},
      } : null,
    } : null;

    return {
      running: this.bot.running,
      scanCount: this.bot.scanCount,
      positionCount: Object.keys(positions).length,
      maxPositions: STRATEGY.MAX_POSITIONS || 3,
      dailyPnl: Math.round(this.bot.risk.getDailyPnl()),
      positions: posEntries,
      symbols: this.bot.symbols,
      symbolData,
      pnlHistory: this.pnlHistory,
      stats: {
        todayBuys: todayBuys.length,
        totalTrades: allSells.length,
        wins: allWins.length,
        losses: allLosses.length,
        winRate: allSells.length > 0 ? Math.round(allWins.length / allSells.length * 100) : 0,
        avgPnl: Math.round(allAvgPnl * 100) / 100,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, pnl: bestTrade.pnl } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, pnl: worstTrade.pnl } : null,
        // 오늘 통계
        todaySells: todaySells.length,
        todayWins: todayWins.length,
        todayLosses: todayLosses.length,
        todayWinRate: todaySells.length > 0 ? Math.round(todayWins.length / todaySells.length * 100) : 0,
        // 상세 P&L
        todayRealizedPnl,
        totalRealizedPnl,
        todayUnrealizedPnl,
        todayAvgPnl,
      },
      todayTrades: todayTrades,
      recentTrades: allTrades,
      learning: learningData,
      regime: this.bot.currentRegime || null,
      drawdown: this.bot.risk.getDrawdownState(),
      sentiment: this.bot.sentiment || null,
      combo: {
        stats: getAllComboStats(),
        minBuyScore: getOptimalMinBuyScore(),
      },
      backtest: this.bot.lastBacktestResult || loadBacktestResults(),
      kimchi: this.bot.kimchiPremium || null,
      balance: this.cachedBalance,
      btcLeader: this.bot.btcLeader ? this.bot.btcLeader.getSummary() : null,
      lossPatterns: this.bot.lossPatterns ? {
        blockCount: this.bot.lossPatterns.blockRules?.filter(r => r.action === 'block').length || 0,
        warnCount: this.bot.lossPatterns.blockRules?.filter(r => r.action === 'warn').length || 0,
        topPatterns: (this.bot.lossPatterns.patterns || []).slice(0, 5),
      } : null,
      paperMode: !!process.env.PAPER_TRADE,
      pendingSignals: Object.keys(this.bot.pendingSignals || {}),
      feePct: STRATEGY.FEE_PCT || 0.05,
      adaptiveFilter: this.bot.risk.getAdaptiveFilter(this.bot.sentiment?.fearGreed?.value || 50),
      consecutiveLosses: this.bot.risk.consecutiveLosses || 0,
      marketMode: this.bot.marketMode || null,
      btcDominance: this.bot.btcDominance || null,
      timestamp: Date.now(),
    };
  }

  async handleCandles(symbol, res) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const candles = await this.bot.exchange.getCandles(symbol, 'minutes/5', 60);
      if (!candles) { res.end('[]'); return; }

      // Calculate Bollinger Bands
      const closes = candles.map(c => c.close);
      const period = 20;
      const bollingerData = closes.map((_, i) => {
        if (i < period - 1) return null;
        const slice = closes.slice(i - period + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
        return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
      });

      const data = candles.map((c, i) => ({
        time: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume,
        bb: bollingerData[i],
      }));

      // Get position info if held
      const positions = this.bot.risk.getPositions();
      const pos = positions[symbol] || null;
      const posInfo = pos ? {
        entryPrice: pos.entryPrice,
        stopLoss: Math.round(pos.stopLoss),
        takeProfit: Math.round(pos.takeProfit),
      } : null;

      res.end(JSON.stringify({ symbol, candles: data, position: posInfo }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  getRecentTrades() {
    try {
      const tradePath = path.join(this.logDir, 'trades.jsonl');
      if (!fs.existsSync(tradePath)) return [];
      const lines = fs.readFileSync(tradePath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-50).map(l => JSON.parse(l)).reverse();
    } catch { return []; }
  }

  _generateIcon(size) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#0B0E11"/>
      <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" font-size="${size * 0.5}" font-family="Arial">📈</text>
    </svg>`;
  }

  _generatePngIcon(size) {
    // 최소 1x1 초록색 PNG (zlib 없이 순수 PNG)
    // PWA 아이콘 등록용 — 실제로는 SVG 아이콘이 표시됨
    const s = Math.min(size, 16); // 작은 크기로 생성 (헤더용)
    const zlib = require('zlib');
    // RGBA raw data: 다크 배경 + 초록 차트 라인
    const rows = [];
    for (let y = 0; y < s; y++) {
      const row = Buffer.alloc(1 + s * 4); // filter byte + RGBA
      row[0] = 0; // no filter
      for (let x = 0; x < s; x++) {
        const off = 1 + x * 4;
        const isChart = Math.abs(y - (s - 1 - Math.round((Math.sin(x / s * Math.PI * 2) * 0.3 + 0.5) * (s - 1)))) <= 1;
        if (isChart) {
          row[off] = 0x00; row[off+1] = 0xE6; row[off+2] = 0x76; row[off+3] = 0xFF; // green
        } else {
          row[off] = 0x0B; row[off+1] = 0x0E; row[off+2] = 0x11; row[off+3] = 0xFF; // dark bg
        }
      }
      rows.push(row);
    }
    const rawData = Buffer.concat(rows);
    const compressed = zlib.deflateSync(rawData);
    // Build PNG
    const png = [];
    // Signature
    png.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
    png.push(this._pngChunk('IHDR', ihdr));
    // IDAT
    png.push(this._pngChunk('IDAT', compressed));
    // IEND
    png.push(this._pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(png);
  }

  _pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4);
    // CRC32
    let c = 0xFFFFFFFF;
    for (let i = 0; i < crcData.length; i++) {
      c ^= crcData[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([len, typeB, data, crc]);
  }

  async _handleRunLearning(ws) {
    try {
      ws.send(JSON.stringify({ type: 'learning_status', data: { status: 'running' } }));
      const result = await this.bot.runLearning();
      ws.send(JSON.stringify({ type: 'learning_status', data: { status: 'done', result } }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'learning_status', data: { status: 'error', error: e.message } }));
    }
  }

  async _handleRunBacktest(ws, symbols) {
    try {
      ws.send(JSON.stringify({ type: 'backtest_status', data: { status: 'running' } }));
      const result = await this.bot.runBacktestNow(symbols);
      ws.send(JSON.stringify({ type: 'backtest_status', data: { status: 'done', result } }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'backtest_status', data: { status: 'error', error: e.message } }));
    }
  }

  _handleRegister(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { inviteCode, nickname, accessKey, secretKey } = data;

        // 초대 코드 확인
        const validCode = process.env.INVITE_CODE || 'trading2026';
        if (inviteCode !== validCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '초대 코드가 올바르지 않습니다' }));
          return;
        }

        // 닉네임 검증
        if (!nickname || !/^[a-zA-Z0-9]+$/.test(nickname)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '닉네임은 영문/숫자만 가능합니다' }));
          return;
        }

        if (nickname === 'example') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '사용할 수 없는 닉네임입니다' }));
          return;
        }

        // API 키 검증
        if (!accessKey || accessKey.length < 10 || !secretKey || secretKey.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'API 키가 올바르지 않습니다' }));
          return;
        }

        // 이미 등록된 유저인지 확인
        const envPath = path.join(USERS_DIR, `${nickname}.env`);
        if (fs.existsSync(envPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '이미 등록된 닉네임입니다' }));
          return;
        }

        // 포트 자동 할당 (기존 유저 수 기반)
        const existingUsers = listUsers();
        const usedPorts = new Set();
        for (const uid of existingUsers) {
          try {
            const uEnvPath = path.join(USERS_DIR, `${uid}.env`);
            const content = fs.readFileSync(uEnvPath, 'utf-8');
            const portMatch = content.match(/DASHBOARD_PORT=(\d+)/);
            if (portMatch) usedPorts.add(parseInt(portMatch[1]));
          } catch { }
        }
        let assignedPort = 3737;
        while (usedPorts.has(assignedPort)) assignedPort++;

        // .env 파일 저장
        if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
        const envContent = [
          `# ${nickname}`,
          `UPBIT_ACCESS_KEY=${accessKey}`,
          `UPBIT_SECRET_KEY=${secretKey}`,
          `DASHBOARD_PORT=${assignedPort}`,
          `TELEGRAM_BOT_TOKEN=`,
          `TELEGRAM_CHAT_ID=`,
          `DISCORD_WEBHOOK_URL=`,
          '',
        ].join('\n');

        fs.writeFileSync(envPath, envContent, 'utf-8');

        const serverHost = req.headers.host ? req.headers.host.split(':')[0] : '서버IP';
        const dashboardUrl = `http://${serverHost}:${assignedPort}`;

        logger.info(TAG, `새 유저 등록: ${nickname} (포트 ${assignedPort})`);

        // 콜백으로 새 유저 봇 자동 시작 (pm2 restart 불필요)
        let autoStarted = false;
        if (this.onUserRegistered) {
          try {
            this.onUserRegistered(nickname);
            autoStarted = true;
            logger.info(TAG, `${nickname} 봇 자동 시작 완료`);
          } catch (e) {
            logger.error(TAG, `${nickname} 봇 자동 시작 실패: ${e.message}`);
          }
        }

        const message = autoStarted
          ? `등록 완료! 봇이 자동으로 시작되었습니다. 아래 주소로 접속하세요.`
          : `등록 완료! 오너가 봇을 재시작하면 아래 주소로 접속하세요.`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message,
          dashboardUrl,
          port: assignedPort,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '서버 오류: ' + e.message }));
      }
    });
  }

  /**
   * Admin status: aggregate all users' status + whale alerts
   * Used by /api/admin/status for the owner monitoring page
   */
  _getAdminStatus() {
    const users = listUsers();
    const userStatuses = [];

    // Merged trade count
    let totalMergedTrades = 0;

    for (const userId of users) {
      try {
        const config = getUserConfig(userId);
        const userStatus = {
          userId,
          port: config.port,
          running: false,
          balance: null,
          positionCount: 0,
          dailyPnl: 0,
          scanCount: 0,
          stats: { wins: 0, losses: 0, winRate: 0 },
        };

        // Try to read the user's trades for today stats
        const tradesPath = path.join(config.logDir, 'trades.jsonl');
        if (fs.existsSync(tradesPath)) {
          try {
            const lines = fs.readFileSync(tradesPath, 'utf-8').trim().split('\n').filter(Boolean);
            totalMergedTrades += lines.length;

            // Today's stats
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayMs = todayStart.getTime();

            const todayTrades = [];
            // Read from end for efficiency
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const trade = JSON.parse(lines[i]);
                if (trade.timestamp < todayMs) break;
                todayTrades.push(trade);
              } catch { }
            }

            const sells = todayTrades.filter(t => t.action === 'SELL' && t.pnl != null);
            const wins = sells.filter(t => t.pnl > 0);
            const losses = sells.filter(t => t.pnl <= 0);
            userStatus.stats = {
              wins: wins.length,
              losses: losses.length,
              winRate: sells.length > 0 ? Math.round(wins.length / sells.length * 100) : 0,
            };

            // Sum P&L from today sells
            userStatus.dailyPnl = Math.round(sells.reduce((sum, t) => {
              // pnl is percentage; we need amount-based P&L if available
              return sum + (t.pnl || 0);
            }, 0) * 100) / 100;
          } catch { }
        }

        // Check if this user's bot is running in current process
        // (the bot instance on this server)
        if (this.bot && this.bot.userId === userId) {
          userStatus.running = this.bot.running;
          userStatus.scanCount = this.bot.scanCount;
          userStatus.positionCount = Object.keys(this.bot.risk.getPositions()).length;
          userStatus.dailyPnl = Math.round(this.bot.risk.getDailyPnl());
          try {
            const balance = this.bot.risk.drawdownTracker?.lastBalance;
            if (balance) userStatus.balance = balance;
          } catch { }
        } else {
          // For other users, try reading their positions file
          const posPath = path.join(config.logDir, 'positions.json');
          if (fs.existsSync(posPath)) {
            try {
              const posData = JSON.parse(fs.readFileSync(posPath, 'utf-8'));
              userStatus.positionCount = Object.keys(posData).length;
            } catch { }
          }
          // Check if the user's dashboard port is reachable (simple heuristic: file exists = configured)
          userStatus.running = fs.existsSync(path.join(config.logDir, 'trades.jsonl'));
        }

        userStatuses.push(userStatus);
      } catch (e) {
        userStatuses.push({
          userId,
          port: 0,
          running: false,
          balance: null,
          positionCount: 0,
          dailyPnl: 0,
          scanCount: 0,
          stats: { wins: 0, losses: 0, winRate: 0 },
          error: e.message,
        });
      }
    }

    // Learning status
    let learningStatus = 'No data';
    try {
      const mergedPath = path.join(LOGS_BASE, 'merged-trades.jsonl');
      if (fs.existsSync(mergedPath)) {
        const lineCount = fs.readFileSync(mergedPath, 'utf-8').trim().split('\n').filter(Boolean).length;
        learningStatus = lineCount + ' merged trades';
      }
    } catch { }

    // Whale alerts
    let whaleAlerts = [];
    try {
      whaleAlerts = getCachedWhaleAlerts();
    } catch { }

    return {
      users: userStatuses,
      whale: whaleAlerts,
      globalStats: {
        totalUsers: users.length,
        totalTrades: totalMergedTrades,
        learningStatus,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Read trades.jsonl and aggregate daily P&L for the last 30 days
   */
  getPnlHistoryByTf(tf = '1d') {
    try {
      // 실시간 스냅샷 기반 (15m, 30m, 1h, 4h)
      if (['15m', '30m', '1h', '4h'].includes(tf)) {
        return this._aggregatePnlSnapshots(tf);
      }
      // 일별: trades.jsonl 기반
      return this._getDailyPnlHistory();
    } catch (e) {
      logger.error(TAG, `PnL 히스토리 조회 실패: ${e.message}`);
      return [];
    }
  }

  _aggregatePnlSnapshots(tf) {
    const bucketMs = { '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000 };
    const maxBuckets = { '15m': 96, '30m': 96, '1h': 72, '4h': 42 };
    const bucket = bucketMs[tf] || 3600000;
    const maxN = maxBuckets[tf] || 72;

    // pnlMinuteData 사용 (1분 간격)
    const data = this.pnlMinuteData;
    if (!data.length) {
      // 폴백: trades.jsonl에서 시간 단위 집계
      return this._aggregateTradesByBucket(bucket, maxN);
    }

    // 버킷별 그룹화 (마지막 값 사용)
    const bucketMap = {};
    for (const d of data) {
      const key = Math.floor(d.time / bucket) * bucket;
      bucketMap[key] = d;
    }

    const keys = Object.keys(bucketMap).map(Number).sort((a, b) => a - b).slice(-maxN);
    // 누적은 첫 버킷 기준 상대값
    const baseVal = keys.length > 0 ? bucketMap[keys[0]].total : 0;
    return keys.map(k => {
      const d = bucketMap[k];
      const dt = new Date(k);
      const label = tf === '4h'
        ? (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.getHours() + '시'
        : dt.getHours().toString().padStart(2, '0') + ':' + dt.getMinutes().toString().padStart(2, '0');
      return { date: label, pnl: d.total - baseVal, cumulative: d.total, trades: 0 };
    });
  }

  _aggregateTradesByBucket(bucketMs, maxBuckets) {
    const tradePath = path.join(this.logDir, 'trades.jsonl');
    if (!fs.existsSync(tradePath)) return [];
    const lines = fs.readFileSync(tradePath, 'utf-8').trim().split('\n').filter(Boolean);
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const bucketMap = {};
    for (const t of trades) {
      if (t.action !== 'SELL' || t.pnl == null) continue;
      const key = Math.floor(t.timestamp / bucketMs) * bucketMs;
      if (!bucketMap[key]) bucketMap[key] = { time: key, pnl: 0, trades: 0 };
      const pnlAmount = t.pnlAmount != null ? t.pnlAmount : (t.amount ? t.amount * t.pnl / 100 : t.pnl);
      bucketMap[key].pnl += pnlAmount;
      bucketMap[key].trades++;
    }

    const keys = Object.keys(bucketMap).map(Number).sort((a, b) => a - b).slice(-maxBuckets);
    let cumulative = 0;
    return keys.map(k => {
      const d = bucketMap[k];
      cumulative += d.pnl;
      const dt = new Date(k);
      const isShort = bucketMs < 86400000;
      const label = isShort
        ? dt.getHours().toString().padStart(2, '0') + ':' + dt.getMinutes().toString().padStart(2, '0')
        : dt.toISOString().slice(0, 10);
      return { date: label, pnl: Math.round(d.pnl), cumulative: Math.round(cumulative), trades: d.trades };
    });
  }

  _getDailyPnlHistory() {
    const tradePath = path.join(this.logDir, 'trades.jsonl');
    if (!fs.existsSync(tradePath)) return [];
    const lines = fs.readFileSync(tradePath, 'utf-8').trim().split('\n').filter(Boolean);
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const dailyMap = {};
    for (const t of trades) {
      if (t.action !== 'SELL' || t.pnl == null) continue;
      const date = new Date(t.timestamp).toISOString().slice(0, 10);
      if (!dailyMap[date]) dailyMap[date] = { date, pnl: 0, trades: 0 };
      const pnlAmount = t.pnlAmount != null ? t.pnlAmount : (t.amount ? t.amount * t.pnl / 100 : t.pnl);
      dailyMap[date].pnl += pnlAmount;
      dailyMap[date].trades++;
    }

    const days = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    let cumulative = 0;
    return days.slice(-30).map(d => {
      cumulative += d.pnl;
      return { date: d.date, pnl: Math.round(d.pnl), cumulative: Math.round(cumulative), trades: d.trades };
    });
  }

  // 하위 호환 (기존 호출)
  getPnlHistory() { return this.getPnlHistoryByTf('1d'); }

  /**
   * Get blacklist from blacklist.json
   */
  getBlacklist() {
    try {
      const blPath = path.join(this.logDir, 'blacklist.json');
      if (!fs.existsSync(blPath)) return { mode: 'blacklist', symbols: [] };
      return JSON.parse(fs.readFileSync(blPath, 'utf-8'));
    } catch {
      return { mode: 'blacklist', symbols: [] };
    }
  }

  /**
   * Handle POST /api/blacklist
   */
  _handleBlacklist(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const blPath = path.join(this.logDir, 'blacklist.json');
        let current = this.getBlacklist();

        if (data.action === 'add' && data.symbol) {
          const sym = data.symbol.toUpperCase();
          const formatted = sym.includes('/') ? sym : sym + '/KRW';
          if (!current.symbols.includes(formatted)) {
            current.symbols.push(formatted);
          }
        } else if (data.action === 'remove' && data.symbol) {
          current.symbols = current.symbols.filter(s => s !== data.symbol);
        } else if (data.action === 'set_mode' && data.mode) {
          current.mode = data.mode;
        }

        fs.writeFileSync(blPath, JSON.stringify(current, null, 2), 'utf-8');
        logger.info(TAG, `블랙리스트 업데이트: ${data.action} ${data.symbol || data.mode || ''}`);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, ...current }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  }

  _handleChat(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        if (!this.chatbot) {
          res.writeHead(503, corsHeaders);
          res.end(JSON.stringify({ reply: 'AI 챗봇이 설정되지 않았습니다. ANTHROPIC_API_KEY를 확인하세요.', tokensUsed: 0 }));
          return;
        }
        const data = JSON.parse(body);
        const message = (data.message || '').trim();
        if (!message || message.length > 500) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ reply: '메시지가 비어있거나 너무 깁니다.', tokensUsed: 0 }));
          return;
        }
        const clientId = req.socket.remoteAddress || 'unknown';
        const statusData = this.getStatus();
        const result = await this.chatbot.ask(message, clientId, statusData);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ reply: '서버 오류: ' + e.message, tokensUsed: 0 }));
      }
    });
  }

  stop() {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    this._savePnlMinuteData();
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    logger.info(TAG, '대시보드 서버 종료');
  }
}

module.exports = { DashboardServer };
