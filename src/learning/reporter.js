const TAG = 'LEARN';

function printReport(result, logger) {
  const log = logger
    ? (msg) => logger.info(TAG, msg)
    : (msg) => console.log(`[${TAG}] ${msg}`);

  log('');
  log('══════════════════════════════════════════');
  log('         📊 자가학습 분석 리포트');
  log('══════════════════════════════════════════');
  log(`분석 거래: ${result.tradesAnalyzed}쌍 (전체 ${result.totalTrades}건)`);
  log(`신뢰도: ${(result.confidence * 100).toFixed(0)}%`);
  log('');

  // 종목별 성적표
  printSymbolReport(result.analysis?.bySymbol, log);

  // 시간대별 히트맵
  printHourHeatmap(result.analysis?.byHour, log);

  // 요일별 수익률
  printDayReport(result.analysis?.byDayOfWeek, log);

  // 보유시간 분석
  printHoldTimeReport(result.analysis?.byHoldTime, log);

  // 시그널 조합별 분석
  printReasonReport(result.analysis?.byReason, log);

  // 파라미터 최적화 결과
  printOptimization(result.analysis?.optimization, log);

  // 블랙리스트
  printBlacklist(result.blacklist, log);

  // 추천 사항
  printRecommendations(result, log);

  log('══════════════════════════════════════════');
  log('');
}

function printSymbolReport(bySymbol, log) {
  if (!bySymbol || Object.keys(bySymbol).length === 0) return;

  log('── 종목별 성적표 ──');
  const sorted = Object.values(bySymbol).sort((a, b) => b.score - a.score);
  for (const s of sorted) {
    const bar = makeBar(s.winRate, 10);
    const pnlStr = s.avgPnl >= 0 ? `+${s.avgPnl.toFixed(1)}%` : `${s.avgPnl.toFixed(1)}%`;
    log(`  ${s.symbol.padEnd(12)} ${bar} 승률 ${String(s.winRate).padStart(3)}% | 평균 ${pnlStr.padStart(7)} | ${s.trades}건 | 점수 ${s.score}`);
  }
  log('');
}

function printHourHeatmap(byHour, log) {
  if (!byHour) return;

  log('── 시간대별 수익률 히트맵 ──');
  // 상단 라벨
  let line1 = '  시간  ';
  let line2 = '  수익률';
  let line3 = '  거래수';

  for (let h = 0; h < 24; h++) {
    const stat = byHour[h];
    const hStr = String(h).padStart(2, '0');
    line1 += ` ${hStr}`;

    if (stat.trades === 0) {
      line2 += ' ··';
      line3 += ' ··';
    } else {
      const icon = stat.avgPnl > 1 ? '🟢' : stat.avgPnl > 0 ? '🔵' : stat.avgPnl > -1 ? '🟡' : '🔴';
      line2 += ` ${icon}`;
      line3 += ` ${String(stat.trades).padStart(2)}`;
    }
  }
  log(line1);
  log(line2);
  log(line3);
  log('  범례: 🟢 >+1% | 🔵 0~+1% | 🟡 -1%~0 | 🔴 <-1% | ·· 데이터없음');
  log('');
}

function printDayReport(byDay, log) {
  if (!byDay) return;

  log('── 요일별 수익률 ──');
  for (let d = 0; d < 7; d++) {
    const stat = byDay[d];
    if (stat.trades === 0) {
      log(`  ${stat.day}요일  -- 거래 없음`);
    } else {
      const bar = makeBar(stat.winRate, 8);
      const pnlStr = stat.avgPnl >= 0 ? `+${stat.avgPnl.toFixed(1)}%` : `${stat.avgPnl.toFixed(1)}%`;
      log(`  ${stat.day}요일  ${bar} 승률 ${String(stat.winRate).padStart(3)}% | 평균 ${pnlStr.padStart(7)} | ${stat.trades}건`);
    }
  }
  log('');
}

function printHoldTimeReport(holdTime, log) {
  if (!holdTime) return;

  log('── 보유시간 vs 수익률 ──');
  for (const b of holdTime) {
    if (b.trades === 0) {
      log(`  ${b.label.padEnd(12)} -- 거래 없음`);
    } else {
      const bar = makeBar(b.winRate, 8);
      const pnlStr = b.avgPnl >= 0 ? `+${b.avgPnl.toFixed(1)}%` : `${b.avgPnl.toFixed(1)}%`;
      log(`  ${b.label.padEnd(12)} ${bar} 승률 ${String(b.winRate).padStart(3)}% | 평균 ${pnlStr.padStart(7)} | ${b.trades}건`);
    }
  }
  log('');
}

function printReasonReport(byReason, log) {
  if (!byReason || Object.keys(byReason).length === 0) return;

  log('── 시그널 조합별 성과 ──');
  const sorted = Object.values(byReason).sort((a, b) => b.avgPnl - a.avgPnl);
  for (const r of sorted) {
    const pnlStr = r.avgPnl >= 0 ? `+${r.avgPnl.toFixed(1)}%` : `${r.avgPnl.toFixed(1)}%`;
    log(`  ${r.reason.padEnd(20)} 승률 ${String(r.winRate).padStart(3)}% | 평균 ${pnlStr.padStart(7)} | ${r.trades}건`);
  }
  log('');
}

function printOptimization(optimization, log) {
  if (!optimization) return;

  log('── 파라미터 최적화 ──');

  if (!optimization.params) {
    log(`  ⚠️  ${optimization.reason || '최적화 불가'}`);
    log('');
    return;
  }

  log(`  신뢰도: ${(optimization.confidence * 100).toFixed(0)}%`);
  log('');
  log('  파라미터'.padEnd(22) + '현재값'.padStart(8) + '  →  ' + '최적값'.padStart(8) + '  변화');
  log('  ' + '─'.repeat(55));

  for (const [param, detail] of Object.entries(optimization.details || {})) {
    const fromStr = String(detail.from).padStart(8);
    const toStr = String(detail.to).padStart(8);
    const changed = detail.from !== detail.to;
    const arrow = changed ? ' ✱' : '  ';
    log(`  ${param.padEnd(20)} ${fromStr}  →  ${toStr}${arrow}`);
  }
  log('');
}

function printBlacklist(blacklist, log) {
  if (!blacklist?.length) return;

  log('── 블랙리스트 ──');
  log(`  다음 종목은 3회 이상 거래 + 승률 25% 미만:`);
  for (const sym of blacklist) {
    log(`  🚫 ${sym}`);
  }
  log('');
}

function printRecommendations(result, log) {
  log('── 추천 사항 ──');

  if (result.tradesAnalyzed < 30) {
    log(`  📝 아직 데이터가 부족합니다 (${result.tradesAnalyzed}/30). 더 많은 거래 후 다시 분석하세요.`);
  }

  if (result.preferredHours?.length > 0) {
    log(`  ⏰ 선호 시간대: ${result.preferredHours.map(h => h + '시').join(', ')}`);
  }
  if (result.avoidHours?.length > 0) {
    log(`  🚫 비선호 시간대: ${result.avoidHours.map(h => h + '시').join(', ')}`);
  }
  if (result.blacklist?.length > 0) {
    log(`  ⛔ 블랙리스트 종목: ${result.blacklist.join(', ')}`);
  }

  if (result.confidence >= 0.5 && result.params) {
    log(`  ✅ 학습 파라미터가 적용됩니다 (신뢰도 ${(result.confidence * 100).toFixed(0)}%)`);
  } else if (result.params) {
    log(`  ⚠️  신뢰도 부족으로 기본 파라미터 유지 (${(result.confidence * 100).toFixed(0)}% < 50%)`);
  }

  log('');
}

// ─── 유틸 ───

function makeBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

module.exports = { printReport };
