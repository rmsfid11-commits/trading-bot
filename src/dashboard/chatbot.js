/**
 * Dashboard AI Chatbot — Claude Haiku
 *
 * Stateless: 매 질문마다 현재 봇 상태만 컨텍스트로 전달
 * 속도 제한: 유저당 분당 3회, 시간당 20회
 * 토큰 최소화: max_tokens 300, 시스템 프롬프트 ~500 토큰
 */

const https = require('https');
const { logger } = require('../logger/trade-logger');

const TAG = 'CHAT';

class DashboardChatbot {
  constructor(apiKey, bot) {
    this.apiKey = apiKey;
    this.bot = bot;
    this.rateLimits = new Map(); // ip → { minute: { count, reset }, hour: { count, reset } }
  }

  /**
   * 속도 제한 체크
   * @returns {string|null} 에러 메시지 (null이면 통과)
   */
  checkRateLimit(clientId) {
    const now = Date.now();
    if (!this.rateLimits.has(clientId)) {
      this.rateLimits.set(clientId, {
        minute: { count: 0, reset: now + 60000 },
        hour: { count: 0, reset: now + 3600000 },
      });
    }
    const limits = this.rateLimits.get(clientId);

    // 분 단위 리셋
    if (now > limits.minute.reset) {
      limits.minute = { count: 0, reset: now + 60000 };
    }
    // 시간 단위 리셋
    if (now > limits.hour.reset) {
      limits.hour = { count: 0, reset: now + 3600000 };
    }

    if (limits.minute.count >= 3) {
      const wait = Math.ceil((limits.minute.reset - now) / 1000);
      return `너무 빠릅니다. ${wait}초 후에 다시 질문해주세요.`;
    }
    if (limits.hour.count >= 20) {
      const wait = Math.ceil((limits.hour.reset - now) / 60000);
      return `시간당 질문 한도(20회)를 초과했습니다. ${wait}분 후에 다시 시도해주세요.`;
    }

    limits.minute.count++;
    limits.hour.count++;
    return null;
  }

  /**
   * 봇 상태를 최소한의 텍스트로 요약 (~500 토큰)
   */
  buildContext(statusData) {
    const d = statusData;
    const lines = [];

    // 기본 상태
    lines.push(`봇: ${d.running ? '실행중' : '정지'}, 스캔 ${d.scanCount}회`);
    lines.push(`포지션: ${d.positionCount}/${d.maxPositions}개`);

    // 수익
    const st = d.stats || {};
    lines.push(`오늘 실현손익: ${st.todayRealizedPnl || 0}원, 미실현: ${st.todayUnrealizedPnl || 0}원`);
    lines.push(`누적 실현손익: ${st.totalRealizedPnl || 0}원`);
    lines.push(`오늘 매매: 매수 ${st.todayBuys || 0}건, 매도 ${st.todaySells || 0}건, 승률 ${st.todayWinRate || 0}%`);

    // 포지션 상세
    if (d.positions && d.positions.length > 0) {
      lines.push('보유 포지션:');
      for (const p of d.positions) {
        const sym = (p.symbol || '').replace('/KRW', '');
        lines.push(`  ${sym}: 진입${Math.round(p.entryPrice)}원, 현재${Math.round(p.currentPrice)}원, 수익률${p.pnlPct}%, ${p.holdMinutes}분 보유${p.dcaCount ? ', DCA ' + p.dcaCount + '회' : ''}`);
      }
    }

    // 센티먼트
    if (d.sentiment && d.sentiment.overall) {
      const s = d.sentiment;
      const fg = s.fearGreed || {};
      lines.push(`시장심리: 종합${s.overall.score}, F&G ${fg.value || '-'}(${fg.label || '-'})`);
    }

    // 레짐
    if (d.regime) {
      const regimeMap = { trending: '추세장', ranging: '횡보장', volatile: '급변장', unknown: '분석중' };
      lines.push(`시장상태: ${regimeMap[d.regime.regime] || d.regime.regime}`);
    }

    // 최근 거래 (최대 5건)
    const recentSells = (d.todayTrades || []).filter(t => t.action === 'SELL' && t.pnl != null).slice(0, 5);
    if (recentSells.length > 0) {
      lines.push('오늘 매도:');
      for (const t of recentSells) {
        const sym = (t.symbol || '').replace('/KRW', '');
        lines.push(`  ${sym}: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}%`);
      }
    }

    // 페이퍼 모드
    if (d.paperMode) lines.push('(페이퍼 트레이딩 모드)');

    return lines.join('\n');
  }

  /**
   * Claude Haiku API 호출
   */
  async ask(userMessage, clientId, statusData) {
    // 속도 제한
    const limitErr = this.checkRateLimit(clientId);
    if (limitErr) return { reply: limitErr, tokensUsed: 0, limited: true };

    // 컨텍스트 빌드
    const context = this.buildContext(statusData);

    const systemPrompt = `너는 암호화폐 자동매매 봇의 AI 어시스턴트야. 사용자가 봇 상태에 대해 질문하면 아래 현재 상태 정보를 바탕으로 한국어로 간결하게 답변해. 투자 조언은 하지 마. 현재 데이터만 기반으로 사실만 전달해.

현재 상태:
${context}`;

    try {
      const response = await this._callApi(systemPrompt, userMessage);
      logger.info(TAG, `챗봇 응답 (${response.tokensUsed} 토큰): ${userMessage.substring(0, 30)}...`);
      return response;
    } catch (err) {
      logger.error(TAG, `챗봇 API 오류: ${err.message}`);
      return { reply: '죄송합니다, 일시적으로 응답할 수 없습니다.', tokensUsed: 0, error: true };
    }
  }

  /**
   * Anthropic Messages API 호출 (https 직접)
   */
  _callApi(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error.message || 'API error'));
              return;
            }
            const reply = json.content?.[0]?.text || '응답을 생성할 수 없습니다.';
            const tokensUsed = (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0);
            resolve({ reply, tokensUsed });
          } catch (e) {
            reject(new Error('응답 파싱 실패: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('API 타임아웃'));
      });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { DashboardChatbot };
