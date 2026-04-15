import {
  getActiveDipWatches,
  markDipWatchFilled,
  markDipWatchFailed,
  DipWatch,
} from "./db";
import { getMarketsFull, MarketFull } from "./polymarket";
import { buyTokenMarket } from "./trading";
import { sendAlert } from "./telegram";

const DIP_POLL_SECONDS = Number(process.env.DIP_POLL_SECONDS) || 30;

// Cache per-tick so multiple watches on the same event share one HTTP call.
async function fetchCached(
  cache: Map<string, MarketFull[]>,
  eventSlug: string
): Promise<MarketFull[]> {
  const hit = cache.get(eventSlug);
  if (hit) return hit;
  const fresh = await getMarketsFull(eventSlug);
  cache.set(eventSlug, fresh);
  return fresh;
}

async function processWatch(
  watch: DipWatch,
  cache: Map<string, MarketFull[]>
): Promise<void> {
  let markets: MarketFull[];
  try {
    markets = await fetchCached(cache, watch.event_slug);
  } catch (err: any) {
    console.error(
      `dipWatcher #${watch.id}: fetch failed for ${watch.event_slug}:`,
      err?.message ?? err
    );
    return;
  }

  const market = markets.find(
    (m) => m.marketSlug.toLowerCase() === watch.market_slug.toLowerCase()
  );
  if (!market) {
    console.warn(
      `dipWatcher #${watch.id}: market "${watch.market_slug}" not found under event "${watch.event_slug}"`
    );
    return;
  }

  const price = watch.side === "YES" ? market.yesPrice : market.noPrice;
  const tokenId = watch.side === "YES" ? market.yesTokenId : market.noTokenId;

  if (!tokenId) {
    console.warn(`dipWatcher #${watch.id}: missing ${watch.side} tokenId`);
    return;
  }

  if (!(price > 0 && price <= watch.threshold_cents)) {
    // Not cheap enough yet — wait for next tick.
    return;
  }

  console.log(
    `dipWatcher #${watch.id}: DIP HIT! ${watch.event_slug}/${watch.market_slug} ${watch.side} @ ${price}¢ — buying $${watch.max_usd} (LIVE, overrides TRADE_ENABLED)`
  );

  const res = await buyTokenMarket(tokenId, watch.max_usd, market.negRisk);

  if (res.success) {
    const orderId = res.orderId ?? "";
    const estShares = watch.max_usd / (price / 100);
    try {
      await markDipWatchFilled(watch.id, price, orderId);
    } catch (err) {
      console.error(`dipWatcher #${watch.id}: DB update failed:`, err);
    }
    await sendAlert(
      `*DIP BUY* 🟢 (watch #${watch.id})\n\n` +
        `Event: \`${watch.event_slug}\`\n` +
        `Market: ${market.question}\n` +
        `Side: *${watch.side}*\n` +
        `Price: ${price}¢ (≤${watch.threshold_cents}¢ threshold)\n` +
        `Spent: $${watch.max_usd}\n` +
        `Est. shares: ~${estShares.toFixed(2)}\n` +
        `Status: EXECUTED${orderId ? `\nOrder: ${orderId}` : ""}\n` +
        `_Live trade — TRADE_ENABLED bypassed (Telegram override)._`
    );
  } else {
    console.error(`dipWatcher #${watch.id}: buy failed: ${res.error}`);
    try {
      await markDipWatchFailed(watch.id, res.error ?? "unknown");
    } catch {}
    await sendAlert(
      `❌ *DIP BUY FAILED* (watch #${watch.id})\n\n` +
        `Event: \`${watch.event_slug}\`\n` +
        `Market: \`${watch.market_slug}\` ${watch.side} @ ${price}¢\n` +
        `Error: ${res.error}`
    );
  }
}

export async function processDipWatches(): Promise<void> {
  const watches = await getActiveDipWatches();
  if (watches.length === 0) return;
  const cache = new Map<string, MarketFull[]>();
  for (const w of watches) {
    try {
      await processWatch(w, cache);
    } catch (err) {
      console.error(`dipWatcher #${w.id}: processWatch threw:`, err);
    }
  }
}

export function startDipWatcher(): void {
  console.log(
    `dipWatcher: starting, poll interval ${DIP_POLL_SECONDS}s`
  );
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processDipWatches();
    } catch (err) {
      console.error("dipWatcher tick failed:", err);
    } finally {
      running = false;
    }
  };
  // Kick off immediately, then on interval.
  tick();
  setInterval(tick, DIP_POLL_SECONDS * 1000);
}
