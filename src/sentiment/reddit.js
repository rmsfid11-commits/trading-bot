/**
 * Reddit 감시 모듈
 *
 * 공개 JSON API 사용 (API 키 불필요)
 * /r/cryptocurrency, /r/bitcoin, /r/CryptoMarkets 등 모니터링
 *
 * 레딧 공개 API 제한: ~60 req/min (User-Agent 필수)
 */

const https = require('https');
const { scoreSentiment, detectSymbols } = require('./keywords');
const { logger } = require('../logger/trade-logger');

const TAG = 'REDDIT';

const SUBREDDITS = [
  { name: 'cryptocurrency', weight: 1.0 },
  { name: 'bitcoin', weight: 0.8 },
  { name: 'CryptoMarkets', weight: 0.9 },
  { name: 'ethtrader', weight: 0.6 },
  { name: 'altcoin', weight: 0.5 },
];

const USER_AGENT = 'TradingBot/2.0 (Node.js)';
const CACHE_TTL = 600000; // 10분

let cachedResult = null;
let lastFetchTime = 0;

/**
 * Reddit JSON API 호출
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 429) {
        reject(new Error('Reddit rate limit'));
        return;
      }
      // 리다이렉트 처리
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode === 403) {
        // www.reddit.com이 403이면 old.reddit.com 시도
        if (url.includes('www.reddit.com')) {
          const altUrl = url.replace('www.reddit.com', 'old.reddit.com');
          fetchJSON(altUrl).then(resolve).catch(reject);
          return;
        }
        reject(new Error(`HTTP 403 (blocked)`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 서브레딧에서 최근 게시글 + 댓글 가져오기
 * @param {string} subreddit
 * @param {string} sort - 'hot', 'new', 'rising'
 * @param {number} limit - 게시글 수
 */
async function fetchSubreddit(subreddit, sort = 'hot', limit = 25) {
  const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&t=day`;
  const data = await fetchJSON(url);
  const posts = data?.data?.children || [];

  return posts.map(p => {
    const d = p.data;
    return {
      title: d.title || '',
      selftext: (d.selftext || '').slice(0, 500), // 댓글 본문 500자 제한
      score: d.score || 0,       // 업보트-다운보트
      numComments: d.num_comments || 0,
      created: d.created_utc * 1000,
      subreddit,
      url: `https://reddit.com${d.permalink}`,
      flair: d.link_flair_text || '',
    };
  });
}

/**
 * 서브레딧의 인기 댓글 가져오기 (top-level만)
 */
async function fetchTopComments(subreddit, limit = 10) {
  const url = `https://www.reddit.com/r/${subreddit}/comments.json?limit=${limit}`;
  try {
    const data = await fetchJSON(url);
    const comments = data?.data?.children || [];
    return comments.map(c => ({
      body: (c.data.body || '').slice(0, 300),
      score: c.data.score || 0,
      created: (c.data.created_utc || 0) * 1000,
    }));
  } catch {
    return [];
  }
}

/**
 * Reddit 전체 감성 분석
 * @param {string[]} watchSymbols - 감시 중인 심볼 목록
 * @returns {{ overall, bySymbol, posts, buzz }}
 */
async function analyzeReddit(watchSymbols = []) {
  // 캐시 체크
  if (cachedResult && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedResult;
  }

  const allPosts = [];
  const errors = [];

  // 서브레딧별 게시글 수집
  for (const sub of SUBREDDITS) {
    try {
      const posts = await fetchSubreddit(sub.name, 'hot', 25);
      allPosts.push(...posts.map(p => ({ ...p, subWeight: sub.weight })));
      // Rate limit 존중: 서브레딧 사이에 1초 대기
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      errors.push(`r/${sub.name}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    logger.warn(TAG, `일부 서브레딧 조회 실패: ${errors.join(', ')}`);
  }

  // 24시간 이내 게시글만 필터
  const dayAgo = Date.now() - 86400000;
  const recentPosts = allPosts.filter(p => p.created > dayAgo);

  // 전체 감성 점수 계산
  let totalBullish = 0;
  let totalBearish = 0;
  let totalWeight = 0;
  const symbolScores = {}; // symbol → { bullish, bearish, mentions, buzz }
  const hotTopics = [];     // 급상승 주제

  for (const post of recentPosts) {
    const text = `${post.title} ${post.selftext} ${post.flair}`;
    const sentiment = scoreSentiment(text);

    // 게시글 인기도 가중치 (업보트 많을수록 영향 큼)
    const popWeight = Math.min(3, 1 + Math.log10(Math.max(1, post.score)) * 0.5);
    const weight = post.subWeight * popWeight;

    totalBullish += sentiment.bullish * weight;
    totalBearish += sentiment.bearish * weight;
    totalWeight += weight;

    // 심볼별 분석
    const symbols = detectSymbols(text, watchSymbols);
    for (const sym of symbols) {
      if (!symbolScores[sym]) {
        symbolScores[sym] = { bullish: 0, bearish: 0, mentions: 0, topPosts: [] };
      }
      symbolScores[sym].bullish += sentiment.bullish * weight;
      symbolScores[sym].bearish += sentiment.bearish * weight;
      symbolScores[sym].mentions++;
      if (symbolScores[sym].topPosts.length < 3 && post.score > 10) {
        symbolScores[sym].topPosts.push({ title: post.title.slice(0, 80), score: post.score });
      }
    }

    // 인기 게시글 수집 (top 10)
    if (post.score > 50 && sentiment.score !== 0) {
      hotTopics.push({
        title: post.title.slice(0, 100),
        score: post.score,
        sentiment: sentiment.score > 0 ? 'bullish' : 'bearish',
        subreddit: post.subreddit,
      });
    }
  }

  hotTopics.sort((a, b) => b.score - a.score);

  // 전체 감성 점수 (-100 ~ +100 정규화)
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

  // 버즈 감지: 평소 대비 멘션 급증
  const avgMentions = recentPosts.length / Math.max(1, watchSymbols.length);
  const buzzSymbols = Object.entries(bySymbol)
    .filter(([_, d]) => d.mentions > avgMentions * 2 && d.mentions >= 3)
    .map(([sym, d]) => ({ symbol: sym, mentions: d.mentions, sentiment: d.score }));

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
    buzz: buzzSymbols,
    fetchedAt: Date.now(),
    errors,
  };

  cachedResult = result;
  lastFetchTime = Date.now();

  logger.info(TAG, `레딧 분석 완료: ${recentPosts.length}글, 점수 ${overallScore} (${result.overall.signal})${buzzSymbols.length ? ', 버즈: ' + buzzSymbols.map(b => b.symbol.replace('/KRW', '')).join(',') : ''}`);

  return result;
}

/** 캐시 무효화 */
function clearCache() {
  cachedResult = null;
  lastFetchTime = 0;
}

module.exports = { analyzeReddit, clearCache };
