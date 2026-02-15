const https = require('https');
const http = require('http');
const { logger } = require('../logger/trade-logger');

const TAG = 'NOTIFY';

class Notifier {
  constructor() {
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
    this.discordWebhook = process.env.DISCORD_WEBHOOK_URL || '';
    this.enabled = !!(this.telegramToken || this.discordWebhook);
    if (this.enabled) {
      const channels = [];
      if (this.telegramToken) channels.push('Telegram');
      if (this.discordWebhook) channels.push('Discord');
      logger.info(TAG, `알림 활성화: ${channels.join(', ')}`);
    }
  }

  async notify(message, type = 'info') {
    if (!this.enabled) return;
    const emoji = type === 'buy' ? '🟢' : type === 'sell' ? '🔴' : type === 'win' ? '🎉' : type === 'loss' ? '📉' : 'ℹ️';
    const text = `${emoji} ${message}`;

    const promises = [];
    if (this.telegramToken && this.telegramChatId) {
      promises.push(this._sendTelegram(text).catch(e => logger.warn(TAG, `Telegram 전송 실패: ${e.message}`)));
    }
    if (this.discordWebhook) {
      promises.push(this._sendDiscord(text).catch(e => logger.warn(TAG, `Discord 전송 실패: ${e.message}`)));
    }
    await Promise.allSettled(promises);
  }

  async notifyTrade(trade) {
    const sym = trade.symbol.replace('/KRW', '');
    const amt = trade.amount ? `${Math.round(trade.amount).toLocaleString()}원` : '';
    if (trade.action === 'BUY') {
      await this.notify(`${sym} 매수 ${amt} @ ${Math.round(trade.price).toLocaleString()}원\n사유: ${trade.reason || '시그널 매수'}`, 'buy');
    } else {
      const pnl = trade.pnl != null ? `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}%` : '';
      const type = trade.pnl > 0 ? 'win' : 'loss';
      await this.notify(`${sym} 매도 ${amt} ${pnl}\n사유: ${trade.reason || ''}`, type);
    }
  }

  _sendTelegram(text) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ chat_id: this.telegramChatId, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.telegramToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  _sendDiscord(text) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.discordWebhook);
      const data = JSON.stringify({ content: text });
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { Notifier };
