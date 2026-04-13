import "dotenv/config";
import { getEvents, closeDb } from "./db";
import { getYesPrices } from "./polymarket";
import { sendAlert } from "./telegram";

const PRICE_MIN = Number(process.env.PRICE_MIN) || 70;
const PRICE_MAX = Number(process.env.PRICE_MAX) || 97;

async function main() {
  console.log("Fetching events from database...");
  const events = await getEvents();
  console.log(`Found ${events.length} active events`);

  for (const event of events) {
    try {
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

      console.log(`[${event.title}] ${markets.length} market(s)${countdown}`);

      for (const market of markets) {
        console.log(`  - ${market.question}: YES ${market.yesPrice}%`);

        if (market.yesPrice >= PRICE_MIN && market.yesPrice <= PRICE_MAX) {
          const message =
            `*Profitable Market Alert*\n\n` +
            `Event: ${event.title}\n` +
            `Market: ${market.question}\n` +
            `YES Price: ${market.yesPrice}%\n` +
            `Time Left: ${countdown.replace(" | ", "")}\n` +
            `Slug: ${event.slug}`;

          await sendAlert(message);
          console.log(`    -> Alert sent!`);
        }
      }
    } catch (err) {
      console.error(`Error processing event "${event.title}":`, err);
    }
  }

  await closeDb();
  console.log("Done.");
}

main();
