import {
  getActiveDipWatches,
  markDipWatchFilled,
  markDipWatchFailed,
  DipWatch,
} from "./db";
import { getMarketBySlug, MarketFull } from "./polymarket";
import { buyTokenMarket } from "./trading";
import { sendAlert } from "./telegram";

// Mirror of telegramBot.mdEscape — keep local to avoid a cross-module dep.
function mdEscape(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

const DIP_POLL_SECONDS = Number(process.env.DIP_POLL_SECONDS) || 30;

// Cache per-tick so multiple watches on the same market share one HTTP call.
async function fetchCached(
  cache: Map<string, MarketFull>,
  marketSlug: string
): Promise<MarketFull> {
  const hit = cache.get(marketSlug);
  if (hit) return hit;
  const fresh = await getMarketBySlug(marketSlug);
  cache.set(marketSlug, fresh);
  return fresh;
}

async function processWatch(
  watch: DipWatch,
  cache: Map<string, MarketFull>
): Promise<void> {
  let market: MarketFull;
  try {
    market = await fetchCached(cache, watch.market_slug);
  } catch (err: any) {
    console.error(
      `dipWatcher #${watch.id}: fetch failed for ${watch.market_slug}:`,
      err?.message ?? err
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
    `dipWatcher #${watch.id}: DIP HIT! ${watch.market_slug} ${watch.side} @ ${price}¢ — buying $${watch.max_usd} (LIVE, overrides TRADE_ENABLED)`
  );

  const res = await buyTokenMarket(tokenId, watch.max_usd, market.negRisk);

  if (res.success) {
    const orderId = res.orderId ?? "";

    // Pull actual fill size + spend from the CLOB response so the alert
    // reflects reality instead of "max_usd / current_ask".
    // Polymarket's OrderResponse exposes these under slightly different
    // names depending on client version — check all the known ones.
    const raw: any = res.raw ?? {};
    const takingAmount = Number(
      raw.takingAmount ?? raw.taking_amount ?? raw.filledAmount ?? 0
    );
    const makingAmount = Number(
      raw.makingAmount ?? raw.making_amount ?? raw.filledSize ?? 0
    );
    // For a BUY: taking = shares received, making = USDC spent.
    const actualShares = takingAmount > 0 ? takingAmount : watch.max_usd / (price / 100);
    const actualSpentUsd = makingAmount > 0 ? makingAmount : watch.max_usd;
    const avgFillCents =
      actualShares > 0 ? (actualSpentUsd / actualShares) * 100 : price;
    const sharesKnown = takingAmount > 0;

    try {
      await markDipWatchFilled(watch.id, avgFillCents, orderId);
    } catch (err) {
      console.error(`dipWatcher #${watch.id}: DB update failed:`, err);
    }

    console.log(
      `dipWatcher #${watch.id}: FILLED — ${actualShares.toFixed(4)} shares @ ${avgFillCents.toFixed(2)}¢ for $${actualSpentUsd.toFixed(2)}${sharesKnown ? "" : " (estimated, raw response had no fill fields)"}`
    );

    await sendAlert(
      `*DIP BUY FILLED* 🟢 (watch #${watch.id})\n\n` +
        `Market: ${mdEscape(market.question)}\n` +
        `Slug: \`${watch.market_slug}\`\n` +
        `Side: *${watch.side}*\n\n` +
        `*Shares bought:* ${actualShares.toFixed(4)}${sharesKnown ? "" : " _(est.)_"}\n` +
        `*Avg fill price:* ${avgFillCents.toFixed(2)}¢\n` +
        `*Total spent:* $${actualSpentUsd.toFixed(2)}\n\n` +
        `Market ask at trigger: ${price}¢ (≤${watch.threshold_cents}¢ threshold)\n` +
        `Status: EXECUTED${orderId ? `\nOrder: ${mdEscape(orderId)}` : ""}\n` +
        `_Live trade — TRADE\\_ENABLED bypassed (Telegram override)._`
    );
  } else {
    console.error(`dipWatcher #${watch.id}: buy failed: ${res.error}`);
    try {
      await markDipWatchFailed(watch.id, res.error ?? "unknown");
    } catch {}
    await sendAlert(
      `❌ *DIP BUY FAILED* (watch #${watch.id})\n\n` +
        `Market: \`${watch.market_slug}\` ${watch.side} @ ${price}¢\n` +
        `Error: ${mdEscape(String(res.error ?? "unknown"))}`
    );
  }
}

export async function processDipWatches(): Promise<void> {
  const watches = await getActiveDipWatches();
  if (watches.length === 0) return;
  const cache = new Map<string, MarketFull>();
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
