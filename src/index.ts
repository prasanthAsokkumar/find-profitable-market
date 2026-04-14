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
} from "./db";
import { getYesPrices } from "./polymarket";
import { sendAlert } from "./telegram";
import { buyYesMarket, sellYesMarket } from "./trading";

const PRICE_MIN = Number(process.env.PRICE_MIN) || 70;
const PRICE_MAX = Number(process.env.PRICE_MAX) || 97;
const PRICE_CHANGE_THRESHOLD = Number(process.env.PRICE_CHANGE_THRESHOLD) || 10;

const TRADE_ENABLED = (process.env.TRADE_ENABLED ?? "false").toLowerCase() === "true";
const TRADE_AMOUNT_USD = Number(process.env.TRADE_AMOUNT_USD) || 10;
const SELL_TRIGGER_CENTS = Number(process.env.SELL_TRIGGER_CENTS) || 61;
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES) || 2;

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

async function processEvent(event: Awaited<ReturnType<typeof getEvents>>[number]) {
  const markets = await getYesPrices(event.slug);
  const tracked = await getAlertedMarkets(event.id);
  const positions = await getOpenPositions(event.id);

  let countdown = "";
  if (event.end_date) {
    const now = new Date();
    const end = new Date(event.end_date);
    const diffMs = end.getTime() - now.getTime();
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

    // ── SELL-side monitoring: if we hold a position and price dropped to/ below trigger ──
    if (openPos && market.yesPrice <= SELL_TRIGGER_CENTS) {
      lines.push(`    -> position hit sell trigger (${SELL_TRIGGER_CENTS}¢), SELLING ${openPos.shares} shares`);

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

      if (TRADE_ENABLED && !tradeStatus.startsWith("FAILED")) {
        await closePosition(openPos.condition_id);
      } else if (!TRADE_ENABLED) {
        await closePosition(openPos.condition_id);
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
        if (!openPos) {
          if (!market.yesTokenId) {
            lines.push(`    -> cannot buy: missing yesTokenId`);
          } else if (market.yesPrice <= 0) {
            lines.push(`    -> cannot buy: invalid yesPrice`);
          } else {
            const entryPriceUsd = market.yesPrice / 100;
            const shares = TRADE_AMOUNT_USD / entryPriceUsd;

            let tradeStatus = "DISABLED (dry-run)";
            let orderId = "";
            if (TRADE_ENABLED) {
              const res = await buyYesMarket(
                market.yesTokenId,
                TRADE_AMOUNT_USD,
                event.neg_risk
              );
              if (res.success) {
                tradeStatus = "EXECUTED";
                orderId = res.orderId ?? "";
              } else {
                tradeStatus = `FAILED: ${res.error}`;
              }
            }

            if (tradeStatus === "EXECUTED" || tradeStatus === "DISABLED (dry-run)") {
              await insertPosition({
                conditionId: market.conditionId,
                eventId: event.id,
                question: market.question,
                yesTokenId: market.yesTokenId,
                entryPrice: market.yesPrice,
                shares,
                costUsd: TRADE_AMOUNT_USD,
                negRisk: event.neg_risk,
              });
            }

            alerts.push(
              `*BUY* 🟢\n\n` +
                `Event: ${event.title}\n` +
                `Market: ${market.question}\n` +
                `Entry: ${market.yesPrice}%\n` +
                `Spent: ${fmtUsd(TRADE_AMOUNT_USD)}\n` +
                `Shares: ~${shares.toFixed(4)}\n` +
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

async function main() {
  console.log(
    `Trading: ${TRADE_ENABLED ? "ENABLED" : "DISABLED"} | buy=$${TRADE_AMOUNT_USD} | sell<=${SELL_TRIGGER_CENTS}¢ | interval=${INTERVAL_MINUTES}min`
  );

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
