const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { logger } = require('../logger/trade-logger');
const { loadLearnedParams } = require('../learning/analyzer');
const { getAllComboStats, getOptimalMinBuyScore } = require('../learning/combo-tracker');
const { loadBacktestResults } = require('../learning/backtest');
const { STRATEGY } = require('../config/strategy');

const TAG = 'DASH';
const PORT = 3737;
const MAX_HISTORY = 60;
const MAX_LOGS = 100;
const MAX_PNL_HISTORY = 120;

class DashboardServer {
  constructor(bot) {
    this.bot = bot;
    this.wss = null;
    this.server = null;
    this.broadcastInterval = null;
    this.priceHistory = {};
    this.currentPrices = {};
    this.pnlHistory = []; // { time, pnl }
    this.logBuffer = []; // recent log messages
    this.lastSignals = {}; // { symbol: { rsi, bollinger, volume, action } }

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

    // Hook logTrade for real-time trade events
    const origLogTrade = logger.logTrade.bind(logger);
    logger.logTrade = (trade) => {
      origLogTrade(trade);
      self._broadcastTrade(trade);
    };
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
      } else if (req.url === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
        res.end(fs.readFileSync(path.join(__dirname, 'manifest.json')));
      } else if (req.url === '/icon-192.png' || req.url === '/icon-512.png') {
        const size = req.url.includes('192') ? 192 : 512;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(this._generateIcon(size));
      } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStatus()));
      } else if (req.url.startsWith('/api/candles/')) {
        const symbol = decodeURIComponent(req.url.replace('/api/candles/', ''));
        this.handleCandles(symbol, res);
        return;
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      logger.info(TAG, '대시보드 클라이언트 연결');
      ws.send(JSON.stringify({ type: 'status', data: this.getStatus() }));
      ws.send(JSON.stringify({ type: 'trades', data: this.getRecentTrades() }));
      ws.send(JSON.stringify({ type: 'logs', data: this.logBuffer.slice(-30) }));

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
      await this.updatePrices();
      this._captureSignals();
      this._capturePnl();
      const msg = JSON.stringify({ type: 'status', data: this.getStatus() });
      this.wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    }, 5000);

    this.server.listen(PORT, () => {
      logger.info(TAG, `대시보드: http://localhost:${PORT}`);
    });
  }

  async updatePrices() {
    const now = Date.now();
    for (const symbol of this.bot.symbols) {
      try {
        const ticker = await this.bot.exchange.getTicker(symbol);
        if (ticker) {
          this.currentPrices[symbol] = ticker.price;
          if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
          this.priceHistory[symbol].push({ time: now, price: ticker.price, change: ticker.change });
          if (this.priceHistory[symbol].length > MAX_HISTORY)
            this.priceHistory[symbol] = this.priceHistory[symbol].slice(-MAX_HISTORY);
        }
      } catch { }
    }
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
    this.pnlHistory.push({ time: Date.now(), realized: Math.round(pnl), unrealized: Math.round(unrealized), total: Math.round(pnl + unrealized) });
    if (this.pnlHistory.length > MAX_PNL_HISTORY) this.pnlHistory = this.pnlHistory.slice(-MAX_PNL_HISTORY);
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

    // Trade stats — 오늘 매매만 필터
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const allTrades = this.getRecentTrades();
    const todayTrades = allTrades.filter(t => t.timestamp >= todayMs);
    const todayBuys = todayTrades.filter(t => t.action === 'BUY');
    const sells = todayTrades.filter(t => t.action === 'SELL' && t.pnl != null);
    const wins = sells.filter(t => t.pnl > 0);
    const losses = sells.filter(t => t.pnl <= 0);
    const avgPnl = sells.length > 0 ? sells.reduce((s, t) => s + t.pnl, 0) / sells.length : 0;
    const bestTrade = sells.length > 0 ? sells.reduce((b, t) => t.pnl > b.pnl ? t : b, sells[0]) : null;
    const worstTrade = sells.length > 0 ? sells.reduce((w, t) => t.pnl < w.pnl ? t : w, sells[0]) : null;

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
        totalTrades: sells.length,
        wins: wins.length,
        losses: losses.length,
        winRate: sells.length > 0 ? Math.round(wins.length / sells.length * 100) : 0,
        avgPnl: Math.round(avgPnl * 100) / 100,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, pnl: bestTrade.pnl } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, pnl: worstTrade.pnl } : null,
      },
      todayTrades: todayTrades,
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
      paperMode: !!process.env.PAPER_TRADE,
      pendingSignals: Object.keys(this.bot.pendingSignals || {}),
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
      const tradePath = path.join(__dirname, '../../logs/trades.jsonl');
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

  stop() {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    logger.info(TAG, '대시보드 서버 종료');
  }
}

module.exports = { DashboardServer };
