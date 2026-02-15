/**
 * 감성 분석용 키워드 사전
 *
 * 한국어 + 영어 키워드, 가중치 포함
 * weight: 1 = 약한 시그널, 2 = 보통, 3 = 강한 시그널
 */

const BULLISH_KEYWORDS = [
  // 영어 — 강한
  { word: 'moon', weight: 2 },
  { word: 'pump', weight: 2 },
  { word: 'breakout', weight: 3 },
  { word: 'ath', weight: 3 },
  { word: 'all-time high', weight: 3 },
  { word: 'all time high', weight: 3 },
  { word: 'bull run', weight: 3 },
  { word: 'bull market', weight: 2 },
  { word: 'bullish', weight: 2 },
  { word: 'massive rally', weight: 3 },
  { word: 'huge rally', weight: 3 },
  { word: 'surge', weight: 2 },
  { word: 'soar', weight: 2 },
  { word: 'rocket', weight: 2 },
  { word: 'skyrocket', weight: 3 },
  { word: 'adoption', weight: 1 },
  { word: 'institutional', weight: 1 },
  { word: 'etf approved', weight: 3 },
  { word: 'etf approval', weight: 3 },
  { word: 'buy the dip', weight: 1 },
  { word: 'btfd', weight: 1 },
  { word: 'accumulate', weight: 1 },
  { word: 'undervalued', weight: 1 },
  { word: 'halving', weight: 2 },
  { word: 'whale buying', weight: 2 },
  { word: 'golden cross', weight: 2 },
  // 영어 — 약한
  { word: 'buy', weight: 0.5 },
  { word: 'long', weight: 0.5 },
  { word: 'going up', weight: 1 },
  { word: 'looking good', weight: 1 },

  // 한국어 — 강한
  { word: '불장', weight: 3 },
  { word: '폭등', weight: 3 },
  { word: '급등', weight: 2 },
  { word: '상승', weight: 1 },
  { word: '돌파', weight: 2 },
  { word: '신고가', weight: 3 },
  { word: '역대최고', weight: 3 },
  { word: '매수세', weight: 2 },
  { word: '기관매수', weight: 2 },
  { word: '고래매수', weight: 2 },
  { word: '줍줍', weight: 1 },
  { word: '떡상', weight: 2 },
  { word: '달나라', weight: 2 },
  { word: '반감기', weight: 2 },
  { word: '골든크로스', weight: 2 },
  { word: '저점매수', weight: 1 },
  { word: '물량매집', weight: 2 },
  { word: '대세상승', weight: 2 },
  { word: '강세', weight: 1 },
  { word: '호재', weight: 2 },
];

const BEARISH_KEYWORDS = [
  // 영어 — 강한
  { word: 'crash', weight: 3 },
  { word: 'dump', weight: 2 },
  { word: 'bear market', weight: 2 },
  { word: 'bearish', weight: 2 },
  { word: 'collapse', weight: 3 },
  { word: 'plunge', weight: 3 },
  { word: 'sell off', weight: 2 },
  { word: 'sell-off', weight: 2 },
  { word: 'liquidation', weight: 2 },
  { word: 'liquidated', weight: 2 },
  { word: 'rug pull', weight: 3 },
  { word: 'rugpull', weight: 3 },
  { word: 'scam', weight: 2 },
  { word: 'hack', weight: 3 },
  { word: 'hacked', weight: 3 },
  { word: 'exploit', weight: 3 },
  { word: 'ban', weight: 2 },
  { word: 'regulation', weight: 1 },
  { word: 'sec lawsuit', weight: 3 },
  { word: 'death cross', weight: 2 },
  { word: 'bubble', weight: 1 },
  { word: 'ponzi', weight: 2 },
  { word: 'fraud', weight: 3 },
  { word: 'bankrupt', weight: 3 },
  { word: 'insolvent', weight: 3 },
  { word: 'whale dump', weight: 2 },
  // 영어 — 약한
  { word: 'sell', weight: 0.5 },
  { word: 'short', weight: 0.5 },
  { word: 'going down', weight: 1 },
  { word: 'overvalued', weight: 1 },

  // 한국어 — 강한
  { word: '폭락', weight: 3 },
  { word: '급락', weight: 2 },
  { word: '하락', weight: 1 },
  { word: '붕괴', weight: 3 },
  { word: '떡락', weight: 2 },
  { word: '손절', weight: 1 },
  { word: '물렸다', weight: 1 },
  { word: '청산', weight: 2 },
  { word: '강제청산', weight: 3 },
  { word: '먹튀', weight: 3 },
  { word: '해킹', weight: 3 },
  { word: '사기', weight: 2 },
  { word: '규제', weight: 1 },
  { word: '금지', weight: 2 },
  { word: '약세', weight: 1 },
  { word: '악재', weight: 2 },
  { word: '데드크로스', weight: 2 },
  { word: '매도세', weight: 2 },
  { word: '고래매도', weight: 2 },
  { word: '대폭락', weight: 3 },
  { word: '반토막', weight: 3 },
  { word: '투매', weight: 2 },
];

/**
 * 코인 심볼 → 관련 키워드 매핑 (검색/필터용)
 */
const SYMBOL_ALIASES = {
  'BTC/KRW': ['bitcoin', 'btc', '비트코인', '비트'],
  'ETH/KRW': ['ethereum', 'eth', '이더리움', '이더'],
  'XRP/KRW': ['ripple', 'xrp', '리플'],
  'SOL/KRW': ['solana', 'sol', '솔라나'],
  'DOGE/KRW': ['dogecoin', 'doge', '도지코인', '도지'],
  'ADA/KRW': ['cardano', 'ada', '카르다노', '에이다'],
  'AVAX/KRW': ['avalanche', 'avax', '아발란체'],
  'DOT/KRW': ['polkadot', 'dot', '폴카닷'],
  'MATIC/KRW': ['polygon', 'matic', '폴리곤', '매틱'],
  'LINK/KRW': ['chainlink', 'link', '체인링크'],
  'SHIB/KRW': ['shiba', 'shib', '시바이누', '시바'],
  'ATOM/KRW': ['cosmos', 'atom', '코스모스', '아톰'],
  'ARB/KRW': ['arbitrum', 'arb', '아비트럼'],
  'OP/KRW': ['optimism', 'op', '옵티미즘'],
  'APT/KRW': ['aptos', 'apt', '앱토스'],
  'SUI/KRW': ['sui', '수이'],
  'SEI/KRW': ['sei', '세이'],
  'NEAR/KRW': ['near', '니어'],
  'SAND/KRW': ['sandbox', 'sand', '샌드박스'],
};

/**
 * 텍스트에서 감성 점수 추출
 * @param {string} text - 분석할 텍스트
 * @returns {{ bullish: number, bearish: number, score: number }}
 */
function scoreSentiment(text) {
  if (!text) return { bullish: 0, bearish: 0, score: 0 };

  const lower = text.toLowerCase();
  let bullish = 0;
  let bearish = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw.word)) {
      bullish += kw.weight;
    }
  }

  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw.word)) {
      bearish += kw.weight;
    }
  }

  return {
    bullish,
    bearish,
    score: bullish - bearish, // 양수 = 긍정, 음수 = 부정
  };
}

/**
 * 텍스트에서 코인 심볼 감지
 * @param {string} text
 * @param {string[]} watchSymbols - 감시 중인 심볼 목록
 * @returns {string[]} 감지된 심볼 배열
 */
function detectSymbols(text, watchSymbols = []) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];

  for (const symbol of watchSymbols) {
    const aliases = SYMBOL_ALIASES[symbol] || [symbol.replace('/KRW', '').toLowerCase()];
    for (const alias of aliases) {
      if (lower.includes(alias)) {
        found.push(symbol);
        break;
      }
    }
  }

  return found;
}

module.exports = {
  BULLISH_KEYWORDS,
  BEARISH_KEYWORDS,
  SYMBOL_ALIASES,
  scoreSentiment,
  detectSymbols,
};
