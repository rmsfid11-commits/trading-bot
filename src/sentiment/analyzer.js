/**
 * 감성 분석 통합 모듈
 *
 * Reddit + Fear & Greed + 뉴스 RSS를 합산하여
 * 종합 감성 점수 산출
 *
 * 결과를 logs/sentiment.json에 저장
 */

const fs = require('fs');
const path = require('path');
const { analyzeReddit } = require('./reddit');
const { analyzeFearGreed } = require('./fear-greed');
const { analyzeNews } = require('./news');
const { logger } = require('../logger/trade-logger');

const TAG = 'SENTIMENT';
const DEFAULT_SENTIMENT_PATH = path.join(__dirname, '../../logs/sentiment.json');

// 각 소스의 가중치
const SOURCE_WEIGHTS = {
  reddit: 0.35,
  news: 0.25,
  fearGreed: 0.40, // Fear & Greed는 시장 전체 분위기를 가장 잘 반영
};

/**
 * 전체 감성 분석 실행
 * @param {string[]} watchSymbols - 감시 중인 심볼 목록
 * @returns {Object} 종합 감성 데이터
 */
async function analyzeSentiment(watchSymbols = [], logDir = null) {
  const results = {};
  const errors = [];

  // 병렬 실행
  const [redditResult, fearGreedResult, newsResult] = await Promise.allSettled([
    analyzeReddit(watchSymbols),
    analyzeFearGreed(),
    analyzeNews(watchSymbols),
  ]);

  if (redditResult.status === 'fulfilled') {
    results.reddit = redditResult.value;
  } else {
    errors.push(`Reddit: ${redditResult.reason?.message}`);
    results.reddit = { overall: { score: 0, signal: 'neutral' }, bySymbol: {} };
  }

  if (fearGreedResult.status === 'fulfilled') {
    results.fearGreed = fearGreedResult.value;
  } else {
    errors.push(`F&G: ${fearGreedResult.reason?.message}`);
    results.fearGreed = { value: 50, signal: 'neutral', buyBoost: 0 };
  }

  if (newsResult.status === 'fulfilled') {
    results.news = newsResult.value;
  } else {
    errors.push(`News: ${newsResult.reason?.message}`);
    results.news = { overall: { score: 0, signal: 'neutral' }, bySymbol: {} };
  }

  // ─── 종합 점수 계산 ───

  // 전체 시장 감성 (-100 ~ +100)
  const redditScore = results.reddit.overall?.score || 0;
  const newsScore = results.news.overall?.score || 0;
  // Fear & Greed: 0~100을 -100~+100으로 변환
  const fgNormalized = ((results.fearGreed.value || 50) - 50) * 2;

  const overallScore = Math.round(
    redditScore * SOURCE_WEIGHTS.reddit +
    newsScore * SOURCE_WEIGHTS.news +
    fgNormalized * SOURCE_WEIGHTS.fearGreed
  );

  // 종합 시그널
  let signal;
  if (overallScore > 30) signal = 'bullish';
  else if (overallScore > 10) signal = 'mild_bullish';
  else if (overallScore < -30) signal = 'bearish';
  else if (overallScore < -10) signal = 'mild_bearish';
  else signal = 'neutral';

  // 매수/매도 부스트 계산
  let buyBoost = 0;
  let sellBoost = 0;
  if (signal === 'bullish') buyBoost = 1.0;
  else if (signal === 'mild_bullish') buyBoost = 0.5;
  else if (signal === 'bearish') sellBoost = 1.0;
  else if (signal === 'mild_bearish') sellBoost = 0.5;

  // Fear & Greed 역발상: 극도의 공포 = 매수 기회
  buyBoost += results.fearGreed.buyBoost || 0;

  // ─── 종목별 감성 점수 ───

  const bySymbol = {};
  for (const sym of watchSymbols) {
    const redditSym = results.reddit.bySymbol?.[sym];
    const newsSym = results.news.bySymbol?.[sym];

    const rScore = redditSym?.score || 0;
    const nScore = newsSym?.score || 0;
    const mentions = (redditSym?.mentions || 0) + (newsSym?.mentions || 0);

    const symScore = mentions > 0
      ? Math.round(rScore * 0.55 + nScore * 0.45)
      : 0; // 멘션 없으면 0 (데이터 부족)

    let symSignal = 'neutral';
    let symBuyBoost = 0;
    if (symScore > 25) { symSignal = 'bullish'; symBuyBoost = 0.5; }
    else if (symScore > 10) { symSignal = 'mild_bullish'; symBuyBoost = 0.2; }
    else if (symScore < -25) { symSignal = 'bearish'; symBuyBoost = -0.5; }
    else if (symScore < -10) { symSignal = 'mild_bearish'; symBuyBoost = -0.2; }

    bySymbol[sym] = {
      score: symScore,
      signal: symSignal,
      buyBoost: symBuyBoost,
      mentions,
      reddit: redditSym || null,
      news: newsSym || null,
    };
  }

  // ─── 버즈 감지 (급증하는 멘션) ───

  const buzzAlerts = results.reddit.buzz || [];

  // ─── 결과 조합 ───

  const sentiment = {
    overall: {
      score: overallScore,
      signal,
      buyBoost: Math.round(buyBoost * 100) / 100,
      sellBoost: Math.round(sellBoost * 100) / 100,
    },
    fearGreed: {
      value: results.fearGreed.value,
      label: results.fearGreed.label,
      signal: results.fearGreed.signal,
      trend: results.fearGreed.trend,
    },
    reddit: {
      score: redditScore,
      signal: results.reddit.overall?.signal || 'neutral',
      postsAnalyzed: results.reddit.overall?.postsAnalyzed || 0,
    },
    news: {
      score: newsScore,
      signal: results.news.overall?.signal || 'neutral',
      articlesAnalyzed: results.news.overall?.articlesAnalyzed || 0,
      headlines: (results.news.headlines || []).slice(0, 5),
    },
    bySymbol,
    buzz: buzzAlerts,
    hotTopics: (results.reddit.hotTopics || []).slice(0, 5),
    fetchedAt: Date.now(),
    errors,
  };

  // 파일 저장
  _saveSentiment(sentiment, logDir);

  return sentiment;
}

/**
 * 저장된 감성 데이터 로드
 */
function loadSentiment(logDir = null) {
  try {
    const sentPath = logDir ? path.join(logDir, 'sentiment.json') : DEFAULT_SENTIMENT_PATH;
    if (fs.existsSync(sentPath)) {
      const data = JSON.parse(fs.readFileSync(sentPath, 'utf-8'));
      // 30분 이내 데이터만 유효
      if (Date.now() - (data.fetchedAt || 0) < 1800000) {
        return data;
      }
    }
  } catch { }
  return null;
}

function _saveSentiment(data, logDir = null) {
  try {
    const sentPath = logDir ? path.join(logDir, 'sentiment.json') : DEFAULT_SENTIMENT_PATH;
    const dir = path.dirname(sentPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    logger.warn(TAG, `감성 데이터 저장 실패: ${e.message}`);
  }
}

/**
 * 시그널에 적용할 감성 부스트 계산
 * @param {string} symbol - 종목 심볼
 * @param {Object} sentiment - analyzeSentiment() 결과
 * @returns {{ buyBoost, sellBoost, reason }}
 */
function getSentimentBoost(symbol, sentiment) {
  if (!sentiment) return { buyBoost: 0, sellBoost: 0, reason: '' };

  let buyBoost = 0;
  let sellBoost = 0;
  const reasons = [];

  // 1. 전체 시장 감성
  const overall = sentiment.overall;
  if (overall.buyBoost > 0) {
    buyBoost += overall.buyBoost * 0.5; // 전체 감성은 50% 가중치
    reasons.push(`시장감성 ${overall.signal}`);
  }
  if (overall.sellBoost > 0) {
    sellBoost += overall.sellBoost * 0.5;
    reasons.push(`시장감성 ${overall.signal}`);
  }

  // 2. 종목별 감성
  const symData = sentiment.bySymbol?.[symbol];
  if (symData) {
    if (symData.buyBoost > 0) {
      buyBoost += symData.buyBoost;
      reasons.push(`${symbol.replace('/KRW', '')} 감성 ${symData.signal}(${symData.mentions}건)`);
    } else if (symData.buyBoost < 0) {
      sellBoost += Math.abs(symData.buyBoost);
      reasons.push(`${symbol.replace('/KRW', '')} 감성 ${symData.signal}(${symData.mentions}건)`);
    }
  }

  // 3. 버즈 보너스
  const buzzMatch = sentiment.buzz?.find(b => b.symbol === symbol);
  if (buzzMatch) {
    if (buzzMatch.sentiment > 0) {
      buyBoost += 0.3;
      reasons.push(`버즈 감지 (${buzzMatch.mentions}건)`);
    } else if (buzzMatch.sentiment < 0) {
      sellBoost += 0.3;
      reasons.push(`부정 버즈 (${buzzMatch.mentions}건)`);
    }
  }

  return {
    buyBoost: Math.round(buyBoost * 100) / 100,
    sellBoost: Math.round(sellBoost * 100) / 100,
    reason: reasons.join(', '),
  };
}

module.exports = { analyzeSentiment, loadSentiment, getSentimentBoost };
