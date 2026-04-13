import "dotenv/config";
import { getEvents, closeDb } from "./db";
import { getYesPrices } from "./polymarket";
import { sendAlert } from "./telegram";

const PRICE_MIN = Number(process.env.PRICE_MIN) || 70;
const PRICE_MAX = Number(process.env.PRICE_MAX) || 97;

async function processEvent(event: Awaited<ReturnType<typeof getEvents>>[number]) {
  const markets = await getYesPrices(event.slug);

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

  for (const market of markets) {
    lines.push(`  - ${market.question}: YES ${market.yesPrice}%`);

    if (market.yesPrice >= PRICE_MIN && market.yesPrice <= PRICE_MAX) {
      lines.push(`    -> Alert queued`);
      alerts.push(
        `*Profitable Market Alert*\n\n` +
        `Event: ${event.title}\n` +
        `Market: ${market.question}\n` +
        `YES Price: ${market.yesPrice}%\n` +
        `Time Left: ${countdown.replace(" | ", "")}\n` +
        `Slug: ${event.slug}`
      );
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
