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
      const markets = await getYesPrices(event.poly_event_id);
      console.log(`[${event.title}] ${markets.length} market(s)`);

      for (const market of markets) {
        console.log(`  - ${market.question}: YES ${market.yesPrice}%`);

        if (market.yesPrice >= PRICE_MIN && market.yesPrice <= PRICE_MAX) {
          const message =
            `*Profitable Market Alert*\n\n` +
            `Event: ${event.title}\n` +
            `Market: ${market.question}\n` +
            `YES Price: ${market.yesPrice}%\n` +
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
