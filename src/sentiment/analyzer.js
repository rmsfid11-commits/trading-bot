/**
 * 감성 분석 통합 모듈
 *
 * Reddit + CryptoPanic + Fear & Greed + 뉴스 RSS를 합산하여
 * 종합 감성 점수 산출
 *
 * CryptoPanic: Reddit 실패 시 폴백 + 추가 소셜 데이터 소스
 * 결과를 logs/sentiment.json에 저장
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { analyzeReddit } = require('./reddit');
const { analyzeFearGreed } = require('./fear-greed');
const { analyzeNews } = require('./news');
const { scoreSentiment, detectSymbols } = require('./keywords');
const { logger } = require('../logger/trade-logger');

const TAG = 'SENTIMENT';
const DEFAULT_SENTIMENT_PATH = path.join(__dirname, '../../logs/sentiment.json');

// CryptoPanic 설정
const CRYPTOPANIC_URLS = [
  'https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&kind=news',
  'https://cryptopanic.com/api/posts/?auth_token=&filter=hot&public=true',
];
const CRYPTOPANIC_CACHE_TTL = 600000; // 10분
let cryptoPanicCache = null;
let cryptoPanicLastFetch = 0;

// 각 소스의 가중치
const SOURCE_WEIGHTS = {
  reddit: 0.35,
  news: 0.25,
  fearGreed: 0.40, // Fear & Greed는 시장 전체 분위기를 가장 잘 반영
};

/**
 * CryptoPanic API에서 뉴스 가져오기 (HTTP GET)
 * @param {string} url
 * @returns {Promise<Object>}
 */
function _fetchCryptoPanic(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'TradingBot/2.0 (Node.js)',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      // 리다이렉트 처리
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _fetchCryptoPanic(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`CryptoPanic HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`CryptoPanic JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CryptoPanic timeout')); });
  });
}

/**
 * CryptoPanic에서 크립토 뉴스 수집 및 감성 분석
 * Reddit의 폴백 + 추가 데이터 소스 역할
 * @param {string[]} watchSymbols
 * @returns {Object} Reddit과 동일한 형태의 결과
 */
async function analyzeCryptoPanic(watchSymbols = []) {
  // 캐시 체크
  if (cryptoPanicCache && Date.now() - cryptoPanicLastFetch < CRYPTOPANIC_CACHE_TTL) {
    return cryptoPanicCache;
  }

  let posts = [];

  // URL 순차 시도 (첫 번째 성공하면 나머지 스킵)
  for (const url of CRYPTOPANIC_URLS) {
    try {
      const data = await _fetchCryptoPanic(url);
      if (data && data.results && data.results.length > 0) {
        posts = data.results;
        logger.info(TAG, `CryptoPanic 뉴스 ${posts.length}건 수집 완료`);
        break;
      }
    } catch (e) {
      logger.debug?.(TAG, `CryptoPanic URL 실패: ${e.message}`) ||
        logger.warn(TAG, `CryptoPanic URL 실패: ${e.message}`);
    }
  }

  if (posts.length === 0) {
    logger.warn(TAG, 'CryptoPanic: 모든 URL에서 데이터 수집 실패');
    return null;
  }

  // 24시간 이내 뉴스만
  const dayAgo = Date.now() - 86400000;
  const recentPosts = posts.filter(p => {
    const created = p.published_at ? new Date(p.published_at).getTime() : 0;
    return created > dayAgo || created === 0;
  });

  // 감성 분석
  let totalBullish = 0;
  let totalBearish = 0;
  let totalWeight = 0;
  const symbolScores = {};
  const hotTopics = [];

  for (const post of recentPosts) {
    const title = post.title || '';
    // CryptoPanic 자체 투표 데이터 활용
    const votes = post.votes || {};
    const cpPositive = (votes.positive || 0);
    const cpNegative = (votes.negative || 0);

    // 키워드 기반 감성 분석
    const sentiment = scoreSentiment(title);

    // CryptoPanic 투표를 추가 시그널로 반영
    let voteBoost = 0;
    if (cpPositive + cpNegative > 0) {
      voteBoost = (cpPositive - cpNegative) / (cpPositive + cpNegative) * 2;
    }

    const popWeight = 1 + (cpPositive + cpNegative) * 0.1;
    const weight = Math.min(3, popWeight);

    totalBullish += (sentiment.bullish + Math.max(0, voteBoost)) * weight;
    totalBearish += (sentiment.bearish + Math.max(0, -voteBoost)) * weight;
    totalWeight += weight;

    // 심볼별 분석
    const symbols = detectSymbols(title, watchSymbols);

    // CryptoPanic currencies 필드도 심볼 매칭에 활용
    if (post.currencies) {
      for (const curr of post.currencies) {
        const code = curr.code;
        for (const sym of watchSymbols) {
          const base = sym.replace('/KRW', '').replace('/USDT', '').replace('/USD', '');
          if (code && code.toUpperCase() === base.toUpperCase() && !symbols.includes(sym)) {
            symbols.push(sym);
          }
        }
      }
    }

    for (const sym of symbols) {
      if (!symbolScores[sym]) {
        symbolScores[sym] = { bullish: 0, bearish: 0, mentions: 0, topPosts: [] };
      }
      symbolScores[sym].bullish += (sentiment.bullish + Math.max(0, voteBoost)) * weight;
      symbolScores[sym].bearish += (sentiment.bearish + Math.max(0, -voteBoost)) * weight;
      symbolScores[sym].mentions++;
      if (symbolScores[sym].topPosts.length < 3) {
        symbolScores[sym].topPosts.push({ title: title.slice(0, 80), score: cpPositive });
      }
    }

    // 인기 뉴스 수집
    if (cpPositive > 3 && sentiment.score !== 0) {
      hotTopics.push({
        title: title.slice(0, 100),
        score: cpPositive,
        sentiment: sentiment.score > 0 ? 'bullish' : 'bearish',
        source: 'CryptoPanic',
      });
    }
  }

  hotTopics.sort((a, b) => b.score - a.score);

  // 전체 감성 점수 (-100 ~ +100)
  const rawScore = totalWeight > 0 ? (totalBullish - totalBearish) / totalWeight : 0;
  const overallScore = Math.max(-100, Math.min(100, Math.round(rawScore * 20)));

  // 종목별 점수 정규화
  const bySymbol = {};
  for (const [sym, data] of Object.entries(symbolScores)) {
    const symRaw = data.mentions > 0 ? (data.bullish - data.bearish) / data.mentions : 0;
    bySymbol[sym] = {
      score: Math.max(-100, Math.min(100, Math.round(symRaw * 15))),
      mentions: data.mentions,
      bullish: Math.round(data.bullish * 10) / 10,
      bearish: Math.round(data.bearish * 10) / 10,
      topPosts: data.topPosts,
    };
  }

  const result = {
    overall: {
      score: overallScore,
      bullish: Math.round(totalBullish * 10) / 10,
      bearish: Math.round(totalBearish * 10) / 10,
      postsAnalyzed: recentPosts.length,
      signal: overallScore > 20 ? 'bullish' : overallScore < -20 ? 'bearish' : 'neutral',
    },
    bySymbol,
    hotTopics: hotTopics.slice(0, 10),
    buzz: [],
    fetchedAt: Date.now(),
    source: 'CryptoPanic',
  };

  cryptoPanicCache = result;
  cryptoPanicLastFetch = Date.now();

  logger.info(TAG, `CryptoPanic 분석 완료: ${recentPosts.length}건, 점수 ${overallScore} (${result.overall.signal})`);

  return result;
}

/**
 * Reddit 결과와 CryptoPanic 결과를 병합
 * Reddit이 실패한 경우 CryptoPanic만 사용, 둘 다 있으면 합산
 * @param {Object|null} redditData
 * @param {Object|null} cryptoPanicData
 * @returns {Object} 병합된 결과 (Reddit 형태와 동일)
 */
function _mergeRedditAndCryptoPanic(redditData, cryptoPanicData) {
  if (!cryptoPanicData) return redditData;
  if (!redditData || (redditData.overall?.postsAnalyzed || 0) === 0) {
    // Reddit 완전 실패 → CryptoPanic만 사용
    return cryptoPanicData;
  }

  // 둘 다 있으면 합산 (Reddit 60%, CryptoPanic 40%)
  const rWeight = 0.6;
  const cWeight = 0.4;

  const mergedScore = Math.round(
    (redditData.overall.score || 0) * rWeight +
    (cryptoPanicData.overall.score || 0) * cWeight
  );

  const mergedBySymbol = { ...redditData.bySymbol };
  for (const [sym, cpData] of Object.entries(cryptoPanicData.bySymbol || {})) {
    if (mergedBySymbol[sym]) {
      // 기존 Reddit 데이터 + CryptoPanic 데이터 합산
      mergedBySymbol[sym] = {
        ...mergedBySymbol[sym],
        score: Math.round(mergedBySymbol[sym].score * rWeight + cpData.score * cWeight),
        mentions: mergedBySymbol[sym].mentions + cpData.mentions,
        bullish: Math.round((mergedBySymbol[sym].bullish * rWeight + cpData.bullish * cWeight) * 10) / 10,
        bearish: Math.round((mergedBySymbol[sym].bearish * rWeight + cpData.bearish * cWeight) * 10) / 10,
      };
    } else {
      mergedBySymbol[sym] = cpData;
    }
  }

  return {
    overall: {
      ...redditData.overall,
      score: mergedScore,
      postsAnalyzed: (redditData.overall.postsAnalyzed || 0) + (cryptoPanicData.overall.postsAnalyzed || 0),
      signal: mergedScore > 20 ? 'bullish' : mergedScore < -20 ? 'bearish' : 'neutral',
    },
    bySymbol: mergedBySymbol,
    hotTopics: [
      ...(redditData.hotTopics || []),
      ...(cryptoPanicData.hotTopics || []),
    ].sort((a, b) => b.score - a.score).slice(0, 10),
    buzz: redditData.buzz || [],
    fetchedAt: Date.now(),
  };
}

/**
 * 전체 감성 분석 실행
 * @param {string[]} watchSymbols - 감시 중인 심볼 목록
 * @returns {Object} 종합 감성 데이터
 */
async function analyzeSentiment(watchSymbols = [], logDir = null) {
  const results = {};
  const errors = [];

  // 병렬 실행 (CryptoPanic 추가)
  const [redditResult, cryptoPanicResult, fearGreedResult, newsResult] = await Promise.allSettled([
    analyzeReddit(watchSymbols),
    analyzeCryptoPanic(watchSymbols),
    analyzeFearGreed(),
    analyzeNews(watchSymbols),
  ]);

  // Reddit 결과 처리
  let redditData = null;
  if (redditResult.status === 'fulfilled') {
    redditData = redditResult.value;
  } else {
    errors.push(`Reddit: ${redditResult.reason?.message}`);
  }

  // CryptoPanic 결과 처리
  let cryptoPanicData = null;
  if (cryptoPanicResult.status === 'fulfilled' && cryptoPanicResult.value) {
    cryptoPanicData = cryptoPanicResult.value;
  } else if (cryptoPanicResult.status === 'rejected') {
    errors.push(`CryptoPanic: ${cryptoPanicResult.reason?.message}`);
  }

  // Reddit + CryptoPanic 병합 (Reddit 실패 시 CryptoPanic이 폴백 역할)
  const mergedSocial = _mergeRedditAndCryptoPanic(
    redditData || { overall: { score: 0, signal: 'neutral', postsAnalyzed: 0 }, bySymbol: {}, hotTopics: [], buzz: [] },
    cryptoPanicData
  );
  results.reddit = mergedSocial;

  if (!redditData && cryptoPanicData) {
    logger.info(TAG, 'Reddit 실패 → CryptoPanic 폴백 데이터 사용');
  } else if (redditData && cryptoPanicData) {
    logger.info(TAG, 'Reddit + CryptoPanic 병합 데이터 사용');
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
      source: cryptoPanicData && !redditData ? 'CryptoPanic(fallback)' :
              cryptoPanicData && redditData ? 'Reddit+CryptoPanic' : 'Reddit',
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
