class BacktestReporter {
  static formatConsole(result) {
    if (result.error) return `\n  오류: ${result.error}\n`;

    const lines = [];
    lines.push('');
    lines.push('  ╔══════════════════════════════════════════════════════╗');
    lines.push('  ║              백테스트 결과 리포트                    ║');
    lines.push('  ╠══════════════════════════════════════════════════════╣');
    lines.push(`  ║  전략:       ${result.strategy.padEnd(40)}║`);
    lines.push(`  ║  종목:       ${result.symbol.padEnd(40)}║`);
    lines.push(`  ║  기간:       ${new Date(result.period.start).toLocaleDateString()} ~ ${new Date(result.period.end).toLocaleDateString()}`.padEnd(57) + '║');
    lines.push(`  ║  캔들 수:    ${result.period.candleCount.toLocaleString().padEnd(40)}║`);
    lines.push('  ╠══════════════════════════════════════════════════════╣');
    lines.push(`  ║  초기 자본:  ${result.initialCapital.toLocaleString().padEnd(26)}원             ║`);
    lines.push(`  ║  최종 자본:  ${result.finalCapital.toLocaleString().padEnd(26)}원             ║`);

    const retColor = result.totalReturn >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    lines.push(`  ║  총 수익률:  ${retColor}${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn}%${reset}`.padEnd(66) + '║');

    lines.push('  ╠══════════════════════════════════════════════════════╣');
    lines.push(`  ║  총 거래:    ${String(result.totalTrades).padEnd(40)}║`);
    lines.push(`  ║  승리:       \x1b[32m${String(result.wins).padEnd(40)}\x1b[0m║`);
    lines.push(`  ║  패배:       \x1b[31m${String(result.losses).padEnd(40)}\x1b[0m║`);
    lines.push(`  ║  승률:       ${result.winRate}%`.padEnd(57) + '║');
    lines.push(`  ║  평균 승:    +${result.avgWin}%`.padEnd(57) + '║');
    lines.push(`  ║  평균 패:    ${result.avgLoss}%`.padEnd(57) + '║');
    lines.push('  ╠══════════════════════════════════════════════════════╣');
    lines.push(`  ║  최대 낙폭:  ${result.maxDrawdown}%`.padEnd(57) + '║');
    lines.push(`  ║  프로핏팩터: ${result.profitFactor}`.padEnd(57) + '║');
    lines.push(`  ║  샤프비율:   ${result.sharpeRatio}`.padEnd(57) + '║');
    lines.push('  ╚══════════════════════════════════════════════════════╝');

    // Recent trades table
    const sellTrades = result.trades.filter(t => t.type === 'SELL').slice(-10);
    if (sellTrades.length > 0) {
      lines.push('');
      lines.push('  최근 거래:');
      lines.push('  ┌──────────────────┬──────────────┬──────────────┬──────────┬──────────┐');
      lines.push('  │ 시간             │ 진입가       │ 청산가       │ 수익률   │ 손익     │');
      lines.push('  ├──────────────────┼──────────────┼──────────────┼──────────┼──────────┤');
      for (const t of sellTrades) {
        const time = new Date(t.exitTime).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const entry = Math.round(t.entryPrice).toLocaleString();
        const exit = Math.round(t.exitPrice).toLocaleString();
        const pnlPct = `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}%`;
        const pnlAmt = `${t.pnlAmount >= 0 ? '+' : ''}${t.pnlAmount.toLocaleString()}`;
        const color = t.pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m';
        lines.push(`  │ ${time.padEnd(16)} │ ${entry.padStart(12)} │ ${exit.padStart(12)} │ ${color}${pnlPct.padStart(8)}${reset} │ ${color}${pnlAmt.padStart(8)}${reset} │`);
      }
      lines.push('  └──────────────────┴──────────────┴──────────────┴──────────┴──────────┘');
    }

    lines.push('');
    return lines.join('\n');
  }

  static formatJSON(result) {
    return {
      strategy: result.strategy,
      symbol: result.symbol,
      period: {
        start: new Date(result.period.start).toISOString(),
        end: new Date(result.period.end).toISOString(),
        candleCount: result.period.candleCount,
      },
      performance: {
        initialCapital: result.initialCapital,
        finalCapital: result.finalCapital,
        totalReturn: result.totalReturn,
        maxDrawdown: result.maxDrawdown,
        sharpeRatio: result.sharpeRatio,
        profitFactor: result.profitFactor,
      },
      trades: {
        total: result.totalTrades,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
      },
      recentTrades: result.trades.filter(t => t.type === 'SELL').slice(-20).map(t => ({
        entryTime: new Date(t.entryTime).toISOString(),
        exitTime: new Date(t.exitTime).toISOString(),
        entryPrice: Math.round(t.entryPrice),
        exitPrice: Math.round(t.exitPrice),
        pnlPct: t.pnlPct,
        pnlAmount: t.pnlAmount,
        reason: t.reason,
        holdBars: t.holdBars,
      })),
      equityCurve: result.equityCurve.filter((_, i) => i % Math.max(1, Math.floor(result.equityCurve.length / 100)) === 0),
    };
  }

  static formatMonthly(result) {
    const sellTrades = result.trades.filter(t => t.type === 'SELL');
    const monthly = {};

    for (const t of sellTrades) {
      const date = new Date(t.exitTime);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly[key]) monthly[key] = { trades: 0, wins: 0, pnl: 0 };
      monthly[key].trades++;
      if (t.pnlPct > 0) monthly[key].wins++;
      monthly[key].pnl += t.pnlAmount;
    }

    const lines = ['\n  월별 수익 분석:'];
    lines.push('  ┌────────────┬──────────┬──────────┬──────────────┐');
    lines.push('  │ 월         │ 거래     │ 승률     │ 손익         │');
    lines.push('  ├────────────┼──────────┼──────────┼──────────────┤');

    for (const [month, data] of Object.entries(monthly).sort()) {
      const winRate = data.trades > 0 ? Math.round((data.wins / data.trades) * 100) : 0;
      const pnl = `${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}`;
      const color = data.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      lines.push(`  │ ${month.padEnd(10)} │ ${String(data.trades).padStart(8)} │ ${String(winRate + '%').padStart(8)} │ ${color}${pnl.padStart(12)}${reset} │`);
    }
    lines.push('  └────────────┴──────────┴──────────┴──────────────┘');
    return lines.join('\n');
  }
}

module.exports = { BacktestReporter };
