import axios from "axios";
import { sendAlert } from "./telegram";
import {
  insertDipWatch,
  getActiveDipWatches,
  cancelDipWatch,
} from "./db";
import { getMarketsFull, getMarketBySlug } from "./polymarket";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID ?? "");
const DIP_THRESHOLD_CENTS = Number(process.env.DIP_THRESHOLD_CENTS) || 5;
const DIP_MAX_USD = Number(process.env.DIP_MAX_USD) || 50;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Escape characters that break legacy Telegram Markdown parse_mode.
// The sendAlert() helper uses parse_mode: "Markdown", which chokes on
// unbalanced `_`, `*`, `[`, or `` ` `` in dynamic content (market questions,
// error strings from the CLOB, etc.).
function mdEscape(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

// Long-poll offset persisted in-memory. On restart we skip old updates by
// calling getUpdates with offset=-1 once to get the latest update id.
let offset = 0;

async function primeOffset(): Promise<void> {
  try {
    const r = await axios.get(`${API}/getUpdates`, {
      params: { timeout: 0, offset: -1 },
    });
    const results = r.data?.result ?? [];
    if (results.length > 0) {
      offset = results[results.length - 1].update_id + 1;
    }
  } catch (err: any) {
    console.error("telegramBot primeOffset failed:", err?.message ?? err);
  }
}

async function pollOnce(): Promise<void> {
  try {
    const r = await axios.get(`${API}/getUpdates`, {
      params: { timeout: 25, offset },
      timeout: 30000,
    });
    const updates = r.data?.result ?? [];
    for (const upd of updates) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg?.text) continue;
      const from = String(msg.chat?.id ?? "");
      if (CHAT_ID && from !== CHAT_ID) {
        console.log(`telegramBot: ignoring message from unauthorized chat ${from}`);
        continue;
      }
      await handleCommand(String(msg.text).trim());
    }
  } catch (err: any) {
    if (err?.code !== "ECONNABORTED") {
      console.error("telegramBot pollOnce failed:", err?.message ?? err);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

async function handleCommand(text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().split("@")[0] ?? "";

  try {
    if (cmd === "/dipbuy") {
      await handleDipBuy(parts.slice(1));
    } else if (cmd === "/diplist") {
      await handleDipList();
    } else if (cmd === "/dipcancel") {
      await handleDipCancel(parts.slice(1));
    } else if (cmd === "/markets") {
      await handleMarkets(parts.slice(1));
    } else if (cmd === "/help" || cmd === "/start") {
      await sendAlert(
        `*Dip-buy commands*\n\n` +
          `\`/markets <event_slug>\`\n` +
          `  List all market slugs + prices under an event\n\n` +
          `\`/dipbuy <market_slug> YES|NO [max_usd]\`\n` +
          `  Register a one-shot buy when price drops ≤${DIP_THRESHOLD_CENTS}¢\n\n` +
          `\`/diplist\` — show active dip watches\n` +
          `\`/dipcancel <market_slug> [YES|NO]\` — cancel a watch`
      );
    }
  } catch (err: any) {
    console.error("telegramBot handleCommand error:", err);
    await sendAlert(`❌ Command failed: ${err?.message ?? err}`);
  }
}

async function handleDipBuy(args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendAlert(
      "Usage: `/dipbuy <market_slug> YES|NO [max_usd]`"
    );
    return;
  }
  const marketSlug = args[0]!;
  const sideRaw = args[1]!;
  const maxUsdRaw = args[2];
  const side = sideRaw.toUpperCase();
  if (side !== "YES" && side !== "NO") {
    await sendAlert("Side must be `YES` or `NO`.");
    return;
  }
  const maxUsd = maxUsdRaw ? Number(maxUsdRaw) : DIP_MAX_USD;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    await sendAlert("Invalid max\\_usd value.");
    return;
  }
  if (maxUsd > DIP_MAX_USD) {
    await sendAlert(
      `Requested $${maxUsd} exceeds hard ceiling DIP\\_MAX\\_USD=$${DIP_MAX_USD}.`
    );
    return;
  }

  // Look up the market directly by its slug — no event slug needed.
  let market;
  try {
    market = await getMarketBySlug(marketSlug);
  } catch (err: any) {
    await sendAlert(
      `❌ Could not fetch market \`${marketSlug}\`: ${mdEscape(String(err?.message ?? err))}`
    );
    return;
  }

  const tokenId = side === "YES" ? market.yesTokenId : market.noTokenId;
  const currentPrice = side === "YES" ? market.yesPrice : market.noPrice;
  if (!tokenId) {
    await sendAlert(`❌ Missing ${side} tokenId for that market.`);
    return;
  }

  try {
    const watch = await insertDipWatch({
      eventSlug: "",  // no longer required — kept for DB compat
      marketSlug,
      side,
      maxUsd,
      thresholdCents: DIP_THRESHOLD_CENTS,
    });
    try {
      await sendAlert(
        `✅ *Dip watch registered* (#${watch.id})\n\n` +
          `Market: ${mdEscape(market.question)}\n` +
          `Slug: \`${marketSlug}\`\n` +
          `Side: *${side}*  (current ${currentPrice}¢)\n` +
          `Threshold: ≤${DIP_THRESHOLD_CENTS}¢\n` +
          `Max spend: $${maxUsd}\n` +
          `Will fire LIVE regardless of TRADE\\_ENABLED.`
      );
    } catch (alertErr: any) {
      console.error("telegramBot: confirmation send failed:", alertErr?.message);
      await sendAlert(
        `✅ Dip watch #${watch.id} registered (confirmation render failed, see /diplist).`
      );
    }
  } catch (err: any) {
    await sendAlert(
      `❌ Could not register watch: ${mdEscape(String(err?.message ?? err))}`
    );
  }
}

async function handleMarkets(args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendAlert("Usage: `/markets <event_slug>`");
    return;
  }
  const eventSlug = args[0]!;

  let markets;
  try {
    markets = await getMarketsFull(eventSlug);
  } catch (err: any) {
    await sendAlert(
      `❌ Could not fetch event \`${eventSlug}\`: ${err?.message ?? err}`
    );
    return;
  }

  if (markets.length === 0) {
    await sendAlert(`No markets found under event \`${eventSlug}\`.`);
    return;
  }

  const header = `*Markets under* \`${eventSlug}\` *(${markets.length})*\n\n`;
  const entries = markets.map((m, i) => {
    const q = m.question.length > 80 ? m.question.slice(0, 77) + "..." : m.question;
    return (
      `${i + 1}. ${mdEscape(q)}\n` +
      `   slug: \`${m.marketSlug}\`\n` +
      `   YES ${m.yesPrice}¢ | NO ${m.noPrice}¢`
    );
  });

  // Telegram caps messages at ~4096 chars. Chunk conservatively at 3500.
  const CHUNK_LIMIT = 3500;
  let buf = header;
  const chunks: string[] = [];
  for (const entry of entries) {
    if (buf.length + entry.length + 2 > CHUNK_LIMIT) {
      chunks.push(buf);
      buf = "";
    }
    buf += entry + "\n\n";
  }
  if (buf.length > 0) chunks.push(buf);

  for (const chunk of chunks) {
    await sendAlert(chunk);
  }
}

async function handleDipList(): Promise<void> {
  const watches = await getActiveDipWatches();
  if (watches.length === 0) {
    await sendAlert("No active dip watches.");
    return;
  }
  const lines = watches.map(
    (w) =>
      `#${w.id} \`${w.market_slug}\` ${w.side} ≤${w.threshold_cents}¢ max $${w.max_usd}`
  );
  await sendAlert(`*Active dip watches*\n\n${lines.join("\n")}`);
}

async function handleDipCancel(args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendAlert("Usage: `/dipcancel <market_slug> [YES|NO]`");
    return;
  }
  const marketSlug = args[0]!;
  const sideRaw = args[1];
  const side = sideRaw ? (sideRaw.toUpperCase() as "YES" | "NO") : undefined;
  if (side && side !== "YES" && side !== "NO") {
    await sendAlert("Side must be `YES` or `NO`.");
    return;
  }
  const n = await cancelDipWatch(marketSlug, side);
  await sendAlert(
    n > 0 ? `✅ Cancelled ${n} watch(es).` : `No matching active watch.`
  );
}

export async function startTelegramBot(): Promise<void> {
  if (!BOT_TOKEN) {
    console.log("telegramBot: TELEGRAM_BOT_TOKEN not set, command listener disabled.");
    return;
  }
  console.log("telegramBot: starting long-poll listener...");
  await primeOffset();
  // Fire-and-forget loop; each pollOnce blocks up to 25s on the server.
  (async () => {
    while (true) {
      await pollOnce();
    }
  })();
}
