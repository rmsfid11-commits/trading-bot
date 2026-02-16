/**
 * 거래 데이터 취합 (Trade Merger)
 *
 * 모든 유저의 trades.jsonl을 합쳐서 logs/merged-trades.jsonl 생성
 * 학습 엔진이 전체 데이터로 분석 → 더 빠른 학습
 *
 * 사용법:
 *   node -e "require('./src/learning/merger').mergeAllTrades()"
 *   또는 multi-launcher에서 주기적 호출
 */

const fs = require('fs');
const path = require('path');
const { listUsers, getUserConfig, LOGS_BASE } = require('../config/users');

const MERGED_PATH = path.join(LOGS_BASE, 'merged-trades.jsonl');

/**
 * 모든 유저의 trades.jsonl을 합쳐서 merged-trades.jsonl 생성
 * @returns {{ totalLines, userCounts, outputPath }}
 */
function mergeAllTrades() {
  const users = listUsers();
  const allLines = [];
  const userCounts = {};

  for (const userId of users) {
    try {
      const config = getUserConfig(userId);
      const tradesPath = path.join(config.logDir, 'trades.jsonl');
      if (!fs.existsSync(tradesPath)) continue;

      const lines = fs.readFileSync(tradesPath, 'utf-8').trim().split('\n').filter(Boolean);
      let count = 0;

      for (const line of lines) {
        try {
          const trade = JSON.parse(line);
          // userId 태그 추가 (원본에 없으면)
          if (!trade.userId) trade.userId = userId;
          allLines.push({ ts: trade.timestamp || 0, line: JSON.stringify(trade) });
          count++;
        } catch { /* 파싱 실패한 라인 스킵 */ }
      }

      userCounts[userId] = count;
    } catch (e) {
      console.error(`[MERGER] ${userId} 거래 데이터 로드 실패: ${e.message}`);
    }
  }

  // 기본 logs/ 폴더의 trades.jsonl도 포함 (마이그레이션 전 데이터)
  const defaultTradesPath = path.join(LOGS_BASE, 'trades.jsonl');
  if (fs.existsSync(defaultTradesPath)) {
    const lines = fs.readFileSync(defaultTradesPath, 'utf-8').trim().split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const trade = JSON.parse(line);
        if (!trade.userId) trade.userId = 'legacy';
        allLines.push({ ts: trade.timestamp || 0, line: JSON.stringify(trade) });
        count++;
      } catch { }
    }
    if (count > 0) userCounts['legacy'] = count;
  }

  // 시간순 정렬
  allLines.sort((a, b) => a.ts - b.ts);

  // 저장
  if (!fs.existsSync(LOGS_BASE)) fs.mkdirSync(LOGS_BASE, { recursive: true });
  fs.writeFileSync(MERGED_PATH, allLines.map(l => l.line).join('\n') + '\n', 'utf-8');

  return {
    totalLines: allLines.length,
    userCounts,
    outputPath: MERGED_PATH,
  };
}

/**
 * 머지된 데이터로 글로벌 학습 실행
 */
function runGlobalAnalysis() {
  const { runAnalysis } = require('./analyzer');
  const { DEFAULT_STRATEGY } = require('../config/strategy');

  // 먼저 전체 데이터 취합
  const mergeResult = mergeAllTrades();
  console.log(`[MERGER] 전체 거래 취합: ${mergeResult.totalLines}건`);
  for (const [user, count] of Object.entries(mergeResult.userCounts)) {
    console.log(`  ${user}: ${count}건`);
  }

  // 머지된 데이터가 있는 logs/ 기본 경로로 분석 실행
  // (merged-trades.jsonl 대신 기본 trades.jsonl을 사용하므로,
  //  글로벌 분석 시에는 mergeAllTrades 후 기본 경로를 사용)
  const result = runAnalysis(DEFAULT_STRATEGY);
  return result;
}

module.exports = { mergeAllTrades, runGlobalAnalysis, MERGED_PATH };
