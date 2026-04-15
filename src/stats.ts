import "dotenv/config";
import {
  closeDb,
  getTradeStats,
  getStatsByEntryPriceBucket,
  getStatsByHoursLeftBucket,
  getStatsByExitReason,
  BucketedStats,
  TradeStats,
} from "./db";

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printHeader(title: string) {
  console.log(`\n${title}`);
  console.log("─".repeat(78));
  console.log(
    "  bucket".padEnd(14) +
      "n".padStart(5) +
      "  win%".padStart(8) +
      "   W/L".padStart(10) +
      "    total P/L".padStart(15) +
      "     avg P/L".padStart(14) +
      "   avg win".padStart(12) +
      "  avg loss".padStart(12)
  );
}

function printRow(label: string, s: TradeStats) {
  console.log(
    "  " +
      label.padEnd(12) +
      String(s.total).padStart(5) +
      fmtPct(s.winRate).padStart(8) +
      `${s.wins}/${s.losses}`.padStart(10) +
      fmtUsd(s.totalPl).padStart(15) +
      fmtUsd(s.avgPl).padStart(14) +
      fmtUsd(s.avgWin).padStart(12) +
      fmtUsd(s.avgLoss).padStart(12)
  );
}

function printBucketTable(title: string, rows: BucketedStats[]) {
  printHeader(title);
  if (rows.length === 0) {
    console.log("  (no data)");
    return;
  }
  for (const r of rows) printRow(r.bucket, r);
}

async function main() {
  const overall = await getTradeStats();
  console.log(`\n=== Trade Stats @ ${new Date().toISOString()} ===`);
  if (overall.total === 0) {
    console.log("No closed trades yet.");
    await closeDb();
    return;
  }

  printHeader("OVERALL");
  printRow("all", overall);

  const breakEven = overall.avgWin > 0 ? -overall.avgLoss / (overall.avgWin - overall.avgLoss) : 0;
  console.log("");
  console.log(
    `  Break-even win rate required: ${fmtPct(breakEven)}  ` +
      `(you're at ${fmtPct(overall.winRate)} → ` +
      `${overall.winRate >= breakEven ? "✅ profitable" : "🔻 unprofitable"})`
  );

  printBucketTable("BY ENTRY PRICE", await getStatsByEntryPriceBucket());
  printBucketTable("BY HOURS LEFT AT ENTRY", await getStatsByHoursLeftBucket());
  printBucketTable("BY EXIT REASON", await getStatsByExitReason());

  console.log("");
  if (overall.total < 30) {
    console.log(
      `⚠  Only ${overall.total} trades — breakdowns are noisy. Wait for ≥50 before tuning.`
    );
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
