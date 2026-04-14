import "dotenv/config";
import {
  getEvents,
  closeDb,
  getAlertedMarkets,
  upsertMarketAlert,
  deleteMarketAlert,
} from "./db";
import { getYesPrices } from "./polymarket";
import { sendAlert } from "./telegram";

const PRICE_MIN = Number(process.env.PRICE_MIN) || 70;
const PRICE_MAX = Number(process.env.PRICE_MAX) || 97;
const PRICE_CHANGE_THRESHOLD = Number(process.env.PRICE_CHANGE_THRESHOLD) || 10;

async function processEvent(event: Awaited<ReturnType<typeof getEvents>>[number]) {
  const markets = await getYesPrices(event.slug);
  const tracked = await getAlertedMarkets(event.id);

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
  lines.push(`  Markets: ${markets.length} ${countdown.replace(" | ", "| ")}`);
  lines.push(`${"─".repeat(60)}`);

  const alerts: string[] = [];

  const toUpsert: { conditionId: string; question: string; yesPrice: number }[] = [];
  const toDelete: string[] = [];

  for (const market of markets) {
    lines.push(`  - ${market.question}: YES ${market.yesPrice}%`);

    const prevPrice = tracked.get(market.conditionId);
    const wasTracked = prevPrice !== undefined;
    const inBand = market.yesPrice >= PRICE_MIN && market.yesPrice <= PRICE_MAX;
    const timeLeft = countdown.replace(" | ", "");

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
        toUpsert.push({ conditionId: market.conditionId, question: market.question, yesPrice: market.yesPrice });
      } else if (prevPrice !== market.yesPrice) {
        const pctChange = prevPrice === 0 ? Infinity : Math.abs((market.yesPrice - prevPrice) / prevPrice) * 100;
        if (pctChange > PRICE_CHANGE_THRESHOLD) {
          const arrow = market.yesPrice > prevPrice ? "▲" : "▼";
          lines.push(`    -> price changed ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}%), alert queued`);
          alerts.push(
            `*Price Update* ${arrow}\n\n` +
            `Event: ${event.title}\n` +
            `Market: ${market.question}\n` +
            `YES Price: ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}% change)\n` +
            `Time Left: ${timeLeft}\n` +
            `Slug: ${event.slug}`
          );
          toUpsert.push({ conditionId: market.conditionId, question: market.question, yesPrice: market.yesPrice });
        } else {
          lines.push(`    -> price changed ${prevPrice}% -> ${market.yesPrice}% (${pctChange.toFixed(1)}%), below ${PRICE_CHANGE_THRESHOLD}% threshold, skipping`);
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

async function main() {
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

  await closeDb();
  console.log("\nDone.");
}

main();
