/**
 * 텔레그램 봇 연동
 *
 * 실시간 매매 알림 + 원격 명령 지원
 * 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * 지원 명령:
 *   /status - 봇 상태
 *   /positions - 보유 포지션
 *   /balance - 잔고
 *   /trades - 오늘 매매 기록
 *   /learn - 자가학습 실행
 *   /backtest - 백테스트 실행
 *   /sell <종목> - 수동 매도 (예: /sell BTC)
 *   /help - 명령어 목록
 */

const https = require('https');
const { logger } = require('../logger/trade-logger');

const TAG = 'TG';

class TelegramBot {
  constructor(bot) {
    this.bot = bot; // TradingBot 인스턴스
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.running = false;
    this.lastUpdateId = 0;
    this.pollInterval = null;
  }

  isConfigured() {
    return !!(this.token && this.chatId);
  }

  start() {
    if (!this.isConfigured()) {
      logger.info(TAG, '텔레그램 봇 설정 안됨 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필요)');
      return;
    }

    this.running = true;
    this.pollInterval = setInterval(() => this.pollUpdates(), 3000);
    logger.info(TAG, '텔레그램 봇 시작');
    this.sendMessage('🤖 트레이딩 봇이 시작되었습니다!');
  }

  stop() {
    this.running = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.isConfigured()) {
      this.sendMessage('🛑 트레이딩 봇이 종료됩니다.');
    }
  }

  // ─── API 호출 ───

  apiCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(params);
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch { reject(new Error('parse error')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async sendMessage(text, parseMode = 'HTML') {
    if (!this.isConfigured()) return;
    try {
      await this.apiCall('sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
    } catch (e) {
      logger.error(TAG, `메시지 전송 실패: ${e.message}`);
    }
  }

  // ─── 폴링 ───

  async pollUpdates() {
    if (!this.running) return;
    try {
      const result = await this.apiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 1,
        allowed_updates: ['message'],
      });

      if (!result.ok || !result.result?.length) return;

      for (const update of result.result) {
        this.lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        // 보안: 설정된 chat_id만 허용
        if (String(msg.chat.id) !== String(this.chatId)) continue;

        await this.handleCommand(msg.text.trim());
      }
    } catch (e) {
      // 폴링 에러는 조용히 무시 (네트워크 일시 끊김 등)
    }
  }

  // ─── 명령 처리 ───

  async handleCommand(text) {
    const [cmd, ...args] = text.split(' ');

    switch (cmd.toLowerCase()) {
      case '/status': return this.cmdStatus();
      case '/positions': case '/pos': return this.cmdPositions();
      case '/balance': case '/bal': return this.cmdBalance();
      case '/trades': return this.cmdTrades();
      case '/learn': return this.cmdLearn();
      case '/backtest': case '/bt': return this.cmdBacktest();
      case '/sell': return this.cmdSell(args[0]);
      case '/help': case '/start': return this.cmdHelp();
      default:
        if (text.startsWith('/')) {
          await this.sendMessage('❓ 알 수 없는 명령어입니다. /help 를 확인하세요.');
        }
    }
  }

  async cmdStatus() {
    const positions = this.bot.risk.getPositions();
    const posCount = Object.keys(positions).length;
    const dailyPnl = this.bot.risk.getDailyPnl();
    const regime = this.bot.currentRegime?.regime || 'unknown';
    const regimeMap = { trending: '추세장', ranging: '횡보장', volatile: '급변장', unknown: '분석중' };
    const dd = this.bot.risk.getDrawdownState();
    const stats = this.bot.risk.getTodayStats();

    let msg = `📊 <b>봇 상태</b>\n\n`;
    msg += `🔄 스캔: ${this.bot.scanCount}회\n`;
    msg += `📈 시장: ${regimeMap[regime] || regime}\n`;
    msg += `💰 포지션: ${posCount}/${dd.dynamicMaxPositions}개\n`;
    msg += `📊 오늘: ${stats.wins}승 ${stats.losses}패\n`;
    msg += `💵 일일 손익: ${dailyPnl >= 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}원\n`;
    msg += `📉 Sharpe: ${dd.sharpeRatio} | DD: ${dd.maxDrawdownPct}%`;

    await this.sendMessage(msg);
  }

  async cmdPositions() {
    const positions = this.bot.risk.getPositions();
    const entries = Object.entries(positions);

    if (entries.length === 0) {
      await this.sendMessage('📭 보유 포지션이 없습니다.');
      return;
    }

    let msg = `📋 <b>보유 포지션</b> (${entries.length}개)\n\n`;

    for (const [symbol, pos] of entries) {
      const sym = symbol.replace('/KRW', '');
      const holdMin = Math.round((Date.now() - pos.entryTime) / 60000);
      const dcaInfo = pos.dcaCount ? ` DCA${pos.dcaCount}` : '';

      msg += `<b>${sym}</b>${dcaInfo}\n`;
      msg += `  진입: ${pos.entryPrice.toLocaleString()}원\n`;
      msg += `  SL: ${Math.round(pos.stopLoss).toLocaleString()} / TP: ${Math.round(pos.takeProfit).toLocaleString()}\n`;
      msg += `  보유: ${holdMin}분${pos.atrPct ? ` | ATR: ${pos.atrPct.toFixed(1)}%` : ''}\n\n`;
    }

    await this.sendMessage(msg);
  }

  async cmdBalance() {
    try {
      const balance = await this.bot.exchange.getBalance();
      if (!balance) {
        await this.sendMessage('❌ 잔고 조회 실패');
        return;
      }

      const positions = this.bot.risk.getPositions();
      let invested = 0;
      for (const pos of Object.values(positions)) {
        invested += pos.amount || 0;
      }

      let msg = `💰 <b>잔고</b>\n\n`;
      msg += `현금: ${Math.round(balance.free).toLocaleString()}원\n`;
      msg += `투자: ${Math.round(invested).toLocaleString()}원\n`;
      msg += `합계: ${Math.round(balance.free + invested).toLocaleString()}원`;

      await this.sendMessage(msg);
    } catch (e) {
      await this.sendMessage(`❌ 잔고 조회 실패: ${e.message}`);
    }
  }

  async cmdTrades() {
    const stats = this.bot.risk.getTodayStats();
    const dailyPnl = this.bot.risk.getDailyPnl();

    let msg = `📜 <b>오늘 매매</b>\n\n`;
    msg += `매수: ${stats.totalBuys}건\n`;
    msg += `매도: ${stats.totalSells}건\n`;
    msg += `승: ${stats.wins} / 패: ${stats.losses}\n`;
    msg += `승률: ${stats.totalSells > 0 ? Math.round(stats.wins / stats.totalSells * 100) : 0}%\n`;
    msg += `실현 손익: ${dailyPnl >= 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}원`;

    await this.sendMessage(msg);
  }

  async cmdLearn() {
    await this.sendMessage('🧠 자가학습을 시작합니다...');
    const result = await this.bot.runLearning();
    if (result) {
      let msg = `✅ <b>학습 완료</b>\n\n`;
      msg += `분석: ${result.tradesAnalyzed}쌍\n`;
      msg += `신뢰도: ${Math.round(result.confidence * 100)}%\n`;
      if (result.blacklist?.length) msg += `블랙리스트: ${result.blacklist.map(s => s.replace('/KRW', '')).join(', ')}\n`;
      await this.sendMessage(msg);
    } else {
      await this.sendMessage('❌ 학습 실패');
    }
  }

  async cmdBacktest() {
    await this.sendMessage('🔬 백테스트를 시작합니다...');
    const result = await this.bot.runBacktestNow();
    if (result?.summary) {
      const s = result.summary;
      let msg = `✅ <b>백테스트 완료</b>\n\n`;
      msg += `현재 승률: ${s.currentAvgWinRate}%\n`;
      msg += `최적 승률: ${s.bestAvgWinRate}%\n`;
      msg += `개선폭: ${s.improvement > 0 ? '+' : ''}${s.improvement}%p\n`;
      if (s.recommendedParams) {
        msg += `\n추천 SL: ${s.recommendedParams.STOP_LOSS_PCT}%\n`;
        msg += `추천 TP: +${s.recommendedParams.TAKE_PROFIT_PCT}%`;
      }
      await this.sendMessage(msg);
    } else {
      await this.sendMessage('❌ 백테스트 실패');
    }
  }

  async cmdSell(symbolArg) {
    if (!symbolArg) {
      await this.sendMessage('사용법: /sell BTC (종목 코드)');
      return;
    }

    const symbol = `${symbolArg.toUpperCase()}/KRW`;
    const positions = this.bot.risk.getPositions();
    const pos = positions[symbol];

    if (!pos) {
      await this.sendMessage(`❌ ${symbolArg.toUpperCase()} 포지션을 보유하고 있지 않습니다.`);
      return;
    }

    try {
      const ticker = await this.bot.exchange.getTicker(symbol);
      if (!ticker) {
        await this.sendMessage('❌ 시세 조회 실패');
        return;
      }

      const pnlPct = ((ticker.price - pos.entryPrice) / pos.entryPrice) * 100;
      await this.bot.executeSell(symbol, pos, ticker.price, '텔레그램 수동 매도', pnlPct);
      await this.sendMessage(`✅ ${symbolArg.toUpperCase()} 매도 완료 (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
    } catch (e) {
      await this.sendMessage(`❌ 매도 실패: ${e.message}`);
    }
  }

  async cmdHelp() {
    const msg = `🤖 <b>트레이딩 봇 명령어</b>\n\n` +
      `/status - 봇 상태\n` +
      `/positions - 보유 포지션\n` +
      `/balance - 잔고 조회\n` +
      `/trades - 오늘 매매 기록\n` +
      `/learn - 자가학습 실행\n` +
      `/backtest - 백테스트 실행\n` +
      `/sell BTC - 수동 매도\n` +
      `/help - 이 도움말`;
    await this.sendMessage(msg);
  }

  // ─── 자동 알림 ───

  async notifyTrade(trade) {
    if (!this.isConfigured()) return;

    const sym = trade.symbol.replace('/KRW', '');
    const isBuy = trade.action === 'BUY' || trade.action === 'DCA';
    const isPartial = trade.action === 'PARTIAL_SELL';

    let emoji, label;
    if (isBuy) { emoji = '🟢'; label = trade.action === 'DCA' ? 'DCA 매수' : '매수'; }
    else if (isPartial) { emoji = '🟡'; label = '분할매도'; }
    else { emoji = trade.pnl >= 0 ? '🎉' : '🔴'; label = '매도'; }

    let msg = `${emoji} <b>${sym} ${label}</b>\n`;
    msg += `💵 ${Math.round(trade.amount || 0).toLocaleString()}원`;
    if (trade.price) msg += ` @ ${trade.price.toLocaleString()}`;
    if (trade.pnl != null) msg += `\n📊 ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}%`;
    if (trade.reason) msg += `\n📝 ${trade.reason}`;

    await this.sendMessage(msg);
  }
}

module.exports = { TelegramBot };
