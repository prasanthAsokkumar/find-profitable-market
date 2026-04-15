import "dotenv/config";
import {
  getEvents,
  closeDb,
  getAlertedMarkets,
  upsertMarketAlert,
  deleteMarketAlert,
  getOpenPositions,
  insertPosition,
  closePosition,
  insertTrade,
  getTradeStats,
} from "./db";
import { getYesPrices } from "./polymarket";
import { sendAlert } from "./telegram";
import { buyYesMarket, sellYesMarket } from "./trading";

const PRICE_MIN = Number(process.env.PRICE_MIN) || 70;
const PRICE_MAX = Number(process.env.PRICE_MAX) || 97;
const PRICE_CHANGE_THRESHOLD = Number(process.env.PRICE_CHANGE_THRESHOLD) || 10;

const TRADE_ENABLED = (process.env.TRADE_ENABLED ?? "false").toLowerCase() === "true";
const TRADE_AMOUNT_USD = Number(process.env.TRADE_AMOUNT_USD) || 10;
// Relative stop-loss: exit if price falls this many cents below entry.
// Replaces the old absolute SELL_TRIGGER_CENTS so risk-per-trade is uniform.
const STOP_LOSS_CENTS = Number(process.env.STOP_LOSS_CENTS) || 15;
// Take-profit: exit once price reaches this cents level (lock in gains on winners).
const TAKE_PROFIT_CENTS = Number(process.env.TAKE_PROFIT_CENTS) || 97;
// Edge-weighted sizing: cost = TRADE_AMOUNT_USD * (yesPrice/100)^POSITION_SIZE_EXPONENT.
// Exponent=0 → flat sizing (old behavior). Exponent=2 → 97¢ gets ~$9.4, 70¢ gets ~$4.9.
const POSITION_SIZE_EXPONENT = Number(process.env.POSITION_SIZE_EXPONENT) || 2;
const POSITION_SIZE_MIN_USD = Number(process.env.POSITION_SIZE_MIN_USD) || 1;
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES) || 2;
const ENTRY_MAX_HOURS_LEFT = Number(process.env.ENTRY_MAX_HOURS_LEFT) || 6;

function computePositionSizeUsd(yesPrice: number): number {
  const weight = Math.pow(yesPrice / 100, POSITION_SIZE_EXPONENT);
  return Math.max(POSITION_SIZE_MIN_USD, TRADE_AMOUNT_USD * weight);
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

async function processEvent(event: Awaited<ReturnType<typeof getEvents>>[number]) {
  const markets = await getYesPrices(event.slug);
  const tracked = await getAlertedMarkets(event.id);
  const positions = await getOpenPositions(event.id);

  let countdown = "";
  let diffMs: number | null = null;
  if (event.end_date) {
    const now = new Date();
    const end = new Date(event.end_date);
    diffMs = end.getTime() - now.getTime();
    if (diffMs <= 0) {
      countdown = " | ENDED";
    } else {
      const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
      const days = Math.floor(totalHours / 24);
      const hours = totalHours % 24;
      countdown = ` | ${days}d ${hours}h remaining`;
    }
  } else {
    countdown = " | No end date";
  }

  const lines: string[] = [];
  lines.push(`\n${"─".repeat(60)}`);
  lines.push(`[${event.title}]`);
  // Pre-filter: a market is only relevant this tick if it's in the price band,
  // was previously tracked (so we may need to alert on drop/change), or we hold
  // an open position in it (so we may need to sell). Everything else is noise.
  const relevantMarkets = markets.filter((m) => {
    const inBand = m.yesPrice >= PRICE_MIN && m.yesPrice <= PRICE_MAX;
    return inBand || tracked.has(m.conditionId) || positions.has(m.conditionId);
  });

  lines.push(
    `  Markets: ${relevantMarkets.length}/${markets.length} relevant ${countdown.replace(" | ", "| ")}`
  );
  lines.push(`${"─".repeat(60)}`);

  const alerts: string[] = [];

  const toUpsert: { conditionId: string; question: string; yesPrice: number }[] = [];
  const toDelete: string[] = [];

  for (const market of relevantMarkets) {
    lines.push(`  - ${market.question}: YES ${market.yesPrice}%`);

    const prevPrice = tracked.get(market.conditionId);
    const wasTracked = prevPrice !== undefined;
    const inBand = market.yesPrice >= PRICE_MIN && market.yesPrice <= PRICE_MAX;
    const timeLeft = countdown.replace(" | ", "");
    const openPos = positions.get(market.conditionId);

    // ── SELL-side monitoring: relative stop-loss OR take-profit ──
    let exitReason: "stop_loss" | "take_profit" | null = null;
    if (openPos) {
      const stopPrice = Math.max(1, openPos.entry_price - STOP_LOSS_CENTS);
      if (market.yesPrice <= stopPrice) exitReason = "stop_loss";
      else if (market.yesPrice >= TAKE_PROFIT_CENTS) exitReason = "take_profit";
    }
    if (openPos && exitReason) {
      const stopPrice = Math.max(1, openPos.entry_price - STOP_LOSS_CENTS);
      const reasonLabel =
        exitReason === "stop_loss"
          ? `stop-loss (entry ${openPos.entry_price}¢ − ${STOP_LOSS_CENTS}¢ = ${stopPrice}¢)`
          : `take-profit (≥${TAKE_PROFIT_CENTS}¢)`;
      lines.push(`    -> ${reasonLabel}, SELLING ${openPos.shares} shares`);

      const currentPriceUsd = market.yesPrice / 100;
      const proceeds = openPos.shares * currentPriceUsd;
      const pl = proceeds - openPos.cost_usd;

      let tradeStatus = "DISABLED (dry-run)";
      let orderId = "";
      if (TRADE_ENABLED) {
        const res = await sellYesMarket(openPos.yes_token_id, openPos.shares, openPos.neg_risk);
        if (res.success) {
          tradeStatus = "EXECUTED";
          orderId = res.orderId ?? "";
        } else {
          tradeStatus = `FAILED: ${res.error}`;
        }
      }

      alerts.push(
        `*SELL* ${pl < 0 ? "🔻" : "🟢"}\n\n` +
          `Event: ${event.title}\n` +
          `Market: ${market.question}\n` +
          `Entry: ${openPos.entry_price}% → Exit: ${market.yesPrice}%\n` +
          `Shares: ${openPos.shares.toFixed(4)}\n` +
          `Cost: ${fmtUsd(openPos.cost_usd)}\n` +
          `Proceeds: ${fmtUsd(proceeds)}\n` +
          `${pl < 0 ? "Loss" : "Profit"}: ${fmtUsd(pl)}\n` +
          `Status: ${tradeStatus}${orderId ? `\nOrder: ${orderId}` : ""}`
      );

      const shouldClose = !TRADE_ENABLED || !tradeStatus.startsWith("FAILED");
      if (shouldClose) {
        await closePosition(openPos.condition_id);
        // Record the round-trip for win-rate / P&L analysis.
        try {
          const holdMinutes = Math.max(
            0,
            Math.round((Date.now() - new Date(openPos.opened_at).getTime()) / 60000)
          );
          await insertTrade({
            conditionId: openPos.condition_id,
            eventId: openPos.event_id,
            question: openPos.question,
            entryPrice: openPos.entry_price,
            exitPrice: market.yesPrice,
            shares: openPos.shares,
            costUsd: openPos.cost_usd,
            proceedsUsd: proceeds,
            plUsd: pl,
            exitReason,
            hoursLeftAtEntry: openPos.hours_left_at_entry,
            holdMinutes,
            openedAt: openPos.opened_at,
          });
        } catch (err) {
          console.error("Failed to record trade:", err);
        }
      }

      // Also untrack this market so the old drop-alert branch doesn't fire again
      if (wasTracked) toDelete.push(market.conditionId);
      continue;
    }

    if (inBand) {
      if (!wasTracked) {
        lines.push(`    -> NEW in band, alert queued`);
        alerts.push(
          `*New Profitable Market*\n\n` +
            `Event: ${event.title}\n` +
            `Market: ${market.question}\n` +
            `YES Price: ${market.yesPrice}%\n` +
            `Time Left: ${timeLeft}\n` +
            `Slug: ${event.slug}`
        );
        toUpsert.push({
          conditionId: market.conditionId,
          question: market.question,
          yesPrice: market.yesPrice,
        });

        // ── BUY-side automation: enter a position if we don't already have one ──
        // Only enter if the event is within the entry window (<= ENTRY_MAX_HOURS_LEFT remaining).
        const withinEntryWindow =
          diffMs !== null && diffMs > 0 && diffMs <= ENTRY_MAX_HOURS_LEFT * 60 * 60 * 1000;
        if (!openPos && !withinEntryWindow) {
          lines.push(
            `    -> skip buy: event not within ${ENTRY_MAX_HOURS_LEFT}h entry window (${timeLeft})`
          );
        } else if (!openPos) {
          if (!market.yesTokenId) {
            lines.push(`    -> cannot buy: missing yesTokenId`);
          } else if (market.yesPrice <= 0) {
            lines.push(`    -> cannot buy: invalid yesPrice`);
          } else {
            const entryPriceUsd = market.yesPrice / 100;
            const sizeUsd = computePositionSizeUsd(market.yesPrice);
            const shares = sizeUsd / entryPriceUsd;

            let tradeStatus = "DISABLED (dry-run)";
            let orderId = "";
            if (TRADE_ENABLED) {
              const res = await buyYesMarket(
                market.yesTokenId,
                sizeUsd,
                event.neg_risk
              );
              if (res.success) {
                tradeStatus = "EXECUTED";
                orderId = res.orderId ?? "";
              } else {
                tradeStatus = `FAILED: ${res.error}`;
              }
            }

            const hoursLeftAtEntry =
              diffMs !== null && diffMs > 0 ? diffMs / (1000 * 60 * 60) : null;
            if (tradeStatus === "EXECUTED" || tradeStatus === "DISABLED (dry-run)") {
              await insertPosition({
                conditionId: market.conditionId,
                eventId: event.id,
                question: market.question,
                yesTokenId: market.yesTokenId,
                entryPrice: market.yesPrice,
                shares,
                costUsd: sizeUsd,
                negRisk: event.neg_risk,
                hoursLeftAtEntry,
              });
            }

            const stopPrice = Math.max(1, market.yesPrice - STOP_LOSS_CENTS);
            alerts.push(
              `*BUY* 🟢\n\n` +
                `Event: ${event.title}\n` +
                `Market: ${market.question}\n` +
                `Entry: ${market.yesPrice}%\n` +
                `Spent: ${fmtUsd(sizeUsd)}\n` +
                `Shares: ~${shares.toFixed(4)}\n` +
                `Stop: ${stopPrice}¢ | Target: ${TAKE_PROFIT_CENTS}¢\n` +
                `Status: ${tradeStatus}${orderId ? `\nOrder: ${orderId}` : ""}`
            );
          }
        }
      } else if (prevPrice !== market.yesPrice) {
        const pctChange =
          prevPrice === 0 ? Infinity : Math.abs((market.yesPrice - prevPrice) / prevPrice) * 100;
        if (pctChange > PRICE_CHANGE_THRESHOLD) {
          const arrow = market.yesPrice > prevPrice ? "▲" : "▼";
          lines.push(
            `    -> price changed ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}%), alert queued`
          );
          alerts.push(
            `*Price Update* ${arrow}\n\n` +
              `Event: ${event.title}\n` +
              `Market: ${market.question}\n` +
              `YES Price: ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}% change)\n` +
              `Time Left: ${timeLeft}\n` +
              `Slug: ${event.slug}`
          );
          toUpsert.push({
            conditionId: market.conditionId,
            question: market.question,
            yesPrice: market.yesPrice,
          });
        } else {
          lines.push(
            `    -> price changed ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}%), below ${PRICE_CHANGE_THRESHOLD}% threshold, skipping`
          );
        }
      } else {
        lines.push(`    -> unchanged, skipping`);
      }
    } else {
      if (wasTracked) {
        if (market.yesPrice < PRICE_MIN) {
          lines.push(`    -> DROPPED below ${PRICE_MIN}%, alert queued`);
          alerts.push(
            `*Market Dropped Below Threshold*\n\n` +
              `Event: ${event.title}\n` +
              `Market: ${market.question}\n` +
              `YES Price: ${prevPrice}% -> ${market.yesPrice}%\n` +
              `Threshold: ${PRICE_MIN}%\n` +
              `Time Left: ${timeLeft}\n` +
              `Slug: ${event.slug}`
          );
        } else {
          lines.push(`    -> moved above ${PRICE_MAX}%, untracking`);
        }
        toDelete.push(market.conditionId);
      }
    }
  }

  // Print all lines for this event at once
  console.log(lines.join("\n"));

  // Send alerts after logging
  for (const msg of alerts) {
    await sendAlert(msg);
  }
  if (alerts.length > 0) {
    console.log(`  ✓ ${alerts.length} alert(s) sent`);
  }

  // Persist state changes after successful alert dispatch
  for (const m of toUpsert) {
    await upsertMarketAlert(m.conditionId, event.id, m.question, m.yesPrice);
  }
  for (const id of toDelete) {
    await deleteMarketAlert(id);
  }
}

async function runOnce() {
  console.log(`\n=== Run @ ${new Date().toISOString()} ===`);
  console.log("Fetching events from database...");
  const events = await getEvents();
  console.log(`Found ${events.length} active events`);

  for (const event of events) {
    try {
      await processEvent(event);
    } catch (err) {
      console.error(`Error processing event "${event.title}":`, err);
    }
  }

  console.log(`Run finished. Next run in ${INTERVAL_MINUTES} min.`);
}

async function printStats() {
  try {
    const s = await getTradeStats();
    if (s.total === 0) {
      console.log("Trade stats: no closed trades yet.");
      return;
    }
    console.log(
      `Trade stats: ${s.total} trades | win rate ${(s.winRate * 100).toFixed(1)}% ` +
        `(${s.wins}W/${s.losses}L) | total P/L ${fmtUsd(s.totalPl)} | ` +
        `avg ${fmtUsd(s.avgPl)} | avg win ${fmtUsd(s.avgWin)} | avg loss ${fmtUsd(s.avgLoss)}`
    );
  } catch (err) {
    console.error("Failed to load trade stats:", err);
  }
}

async function main() {
  console.log(
    `Trading: ${TRADE_ENABLED ? "ENABLED" : "DISABLED"} | ` +
      `base=$${TRADE_AMOUNT_USD} (exp=${POSITION_SIZE_EXPONENT}) | ` +
      `stop=-${STOP_LOSS_CENTS}¢ | target=${TAKE_PROFIT_CENTS}¢ | ` +
      `entry<=${ENTRY_MAX_HOURS_LEFT}h | interval=${INTERVAL_MINUTES}min`
  );
  await printStats();

  let running = false;
  const tick = async () => {
    if (running) {
      console.log("Previous run still in progress, skipping this tick.");
      return;
    }
    running = true;
    try {
      await runOnce();
    } catch (err) {
      console.error("Run failed:", err);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, INTERVAL_MINUTES * 60 * 1000);

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received, shutting down...`);
    try {
      await closeDb();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
