const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { logger } = require('../logger/trade-logger');
const { loadLearnedParams } = require('../learning/analyzer');
const { getAllComboStats, getOptimalMinBuyScore } = require('../learning/combo-tracker');
const { loadBacktestResults } = require('../learning/backtest');
const { STRATEGY } = require('../config/strategy');
const { USERS_DIR, listUsers } = require('../config/users');

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
      } else if (req.url === '/icon-192.png' || req.url === '/icon-512.png') {
        const size = req.url.includes('192') ? 192 : 512;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(this._generateIcon(size));
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
    }, 5000);

    this.server.listen(this.port, () => {
      logger.info(TAG, `대시보드: http://localhost:${this.port}`);
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
        breakevenSet: !!pos.breakevenSet,
        trailingActive: !!pos.trailingActive,
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

  stop() {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    logger.info(TAG, '대시보드 서버 종료');
  }
}

module.exports = { DashboardServer };
