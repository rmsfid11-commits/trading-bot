/**
 * 크립토 뉴스 RSS 피드 모니터링
 *
 * CoinDesk, CoinTelegraph 등의 RSS 피드를 파싱하여
 * 감성 분석 수행
 *
 * API 키 불필요, 완전 무료
 */

const https = require('https');
const { scoreSentiment, detectSymbols } = require('./keywords');
const { logger } = require('../logger/trade-logger');

const TAG = 'NEWS';

const RSS_FEEDS = [
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', weight: 1.0 },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', weight: 0.8 },
  { name: 'TheBlock', url: 'https://www.theblock.co/rss.xml', weight: 0.7 },
];

const CACHE_TTL = 900000; // 15분

let cachedResult = null;
let lastFetchTime = 0;

/**
 * HTTP GET 요청
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'TradingBot/1.0' },
      timeout: 15000,
    }, (res) => {
      // 리다이렉트 처리
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 간단한 RSS/XML 파서 (외부 의존성 없이)
 * <item> 또는 <entry> 태그에서 title, description, pubDate 추출
 */
function parseRSS(xml) {
  const items = [];
  // <item>...</item> 매칭
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  // <entry>...</entry> 매칭 (Atom 피드)
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

  const allMatches = [...xml.matchAll(itemRegex), ...xml.matchAll(entryRegex)];

  for (const match of allMatches) {
    const content = match[1];

    const titleMatch = content.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    const descMatch = content.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/s)
      || content.match(/<summary[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/summary>/s)
      || content.match(/<content[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/content>/s);
    const dateMatch = content.match(/<pubDate[^>]*>(.*?)<\/pubDate>/s)
      || content.match(/<published[^>]*>(.*?)<\/published>/s)
      || content.match(/<updated[^>]*>(.*?)<\/updated>/s);

    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
    const description = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 300) : '';
    const pubDate = dateMatch ? new Date(dateMatch[1].trim()).getTime() : 0;

    if (title) {
      items.push({ title, description, pubDate });
    }
  }

  return items;
}

/**
 * 뉴스 감성 분석
 * @param {string[]} watchSymbols - 감시 중인 심볼 목록
 */
async function analyzeNews(watchSymbols = []) {
  if (cachedResult && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedResult;
  }

  const allArticles = [];
  const errors = [];

  for (const feed of RSS_FEEDS) {
    try {
      const xml = await httpGet(feed.url);
      const items = parseRSS(xml);
      allArticles.push(...items.map(item => ({
        ...item,
        source: feed.name,
        sourceWeight: feed.weight,
      })));
    } catch (e) {
      errors.push(`${feed.name}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    logger.warn(TAG, `일부 뉴스 피드 조회 실패: ${errors.join(', ')}`);
  }

  // 24시간 이내 기사만
  const dayAgo = Date.now() - 86400000;
  const recentArticles = allArticles.filter(a => a.pubDate > dayAgo || a.pubDate === 0);

  // 감성 분석
  let totalBullish = 0;
  let totalBearish = 0;
  const symbolMentions = {};
  const headlines = [];

  for (const article of recentArticles) {
    const text = `${article.title} ${article.description}`;
    const sentiment = scoreSentiment(text);
    const weight = article.sourceWeight;

    totalBullish += sentiment.bullish * weight;
    totalBearish += sentiment.bearish * weight;

    // 심볼별 멘션
    const symbols = detectSymbols(text, watchSymbols);
    for (const sym of symbols) {
      if (!symbolMentions[sym]) {
        symbolMentions[sym] = { bullish: 0, bearish: 0, mentions: 0, headlines: [] };
      }
      symbolMentions[sym].bullish += sentiment.bullish * weight;
      symbolMentions[sym].bearish += sentiment.bearish * weight;
      symbolMentions[sym].mentions++;
      if (symbolMentions[sym].headlines.length < 3) {
        symbolMentions[sym].headlines.push(article.title.slice(0, 80));
      }
    }

    // 주요 헤드라인 (감성 있는 것만)
    if (sentiment.score !== 0) {
      headlines.push({
        title: article.title.slice(0, 100),
        source: article.source,
        sentiment: sentiment.score > 0 ? 'bullish' : 'bearish',
        strength: Math.abs(sentiment.score),
      });
    }
  }

  headlines.sort((a, b) => b.strength - a.strength);

  // 전체 점수
  const total = totalBullish + totalBearish;
  const overallScore = total > 0
    ? Math.round((totalBullish - totalBearish) / total * 100)
    : 0;

  // 종목별 점수
  const bySymbol = {};
  for (const [sym, data] of Object.entries(symbolMentions)) {
    const symTotal = data.bullish + data.bearish;
    bySymbol[sym] = {
      score: symTotal > 0 ? Math.round((data.bullish - data.bearish) / symTotal * 100) : 0,
      mentions: data.mentions,
      headlines: data.headlines,
    };
  }

  const result = {
    overall: {
      score: overallScore,
      articlesAnalyzed: recentArticles.length,
      signal: overallScore > 20 ? 'bullish' : overallScore < -20 ? 'bearish' : 'neutral',
    },
    bySymbol,
    headlines: headlines.slice(0, 15),
    fetchedAt: Date.now(),
    errors,
  };

  cachedResult = result;
  lastFetchTime = Date.now();

  logger.info(TAG, `뉴스 분석 완료: ${recentArticles.length}개 기사, 점수 ${overallScore} (${result.overall.signal})`);

  return result;
}

module.exports = { analyzeNews };
