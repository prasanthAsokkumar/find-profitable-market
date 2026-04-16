import axios from "axios";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

export interface MarketPrice {
  conditionId: string;
  question: string;
  yesPrice: number;
  yesTokenId: string;
}

// Richer shape used by the dip-watcher: we need the NO side and the
// per-market slug so we can match a Telegram command to a specific market.
export interface MarketFull extends MarketPrice {
  marketSlug: string;
  noPrice: number;
  noTokenId: string;
  negRisk: boolean;
}

// Look up a single market directly by its slug (no event slug needed).
// Gamma API: GET /markets/slug/<marketSlug> returns the market object directly.
export async function getMarketBySlug(marketSlug: string): Promise<MarketFull> {
  const response = await axios.get(`${GAMMA_API_URL}/markets/slug/${marketSlug}`);
  const market = response.data;
  if (!market || (!market.conditionId && !market.condition_id)) {
    throw new Error(`Market "${marketSlug}" not found or has no conditionId.`);
  }

  let yesPrice = 0;
  let noPrice = 0;
  try {
    const prices =
      typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
    yesPrice = parseFloat(prices?.[0] ?? market.bestAsk ?? "0") * 100;
    noPrice = parseFloat(prices?.[1] ?? "0") * 100;
  } catch {
    yesPrice = parseFloat(market.bestAsk ?? "0") * 100;
  }

  let yesTokenId = "";
  let noTokenId = "";
  try {
    const tokenIds =
      typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
    yesTokenId = tokenIds?.[0] ?? "";
    noTokenId = tokenIds?.[1] ?? "";
  } catch {
    /* ignore */
  }

  return {
    conditionId: market.conditionId ?? market.condition_id ?? "",
    question: market.question ?? market.description ?? "",
    marketSlug: market.slug ?? marketSlug,
    yesPrice: Math.round(yesPrice * 100) / 100,
    yesTokenId,
    noPrice: Math.round(noPrice * 100) / 100,
    noTokenId,
    negRisk: Boolean(market.negRisk ?? false),
  };
}

export async function getMarketsFull(eventSlug: string): Promise<MarketFull[]> {
  const response = await axios.get(`${GAMMA_API_URL}/events/slug/${eventSlug}`);
  const event = response.data;
  const markets: any[] = event.markets ?? [];

  return markets.map((market) => {
    let yesPrice = 0;
    let noPrice = 0;
    try {
      const prices =
        typeof market.outcomePrices === "string"
          ? JSON.parse(market.outcomePrices)
          : market.outcomePrices;
      yesPrice = parseFloat(prices?.[0] ?? market.bestAsk ?? "0") * 100;
      noPrice = parseFloat(prices?.[1] ?? "0") * 100;
    } catch {
      yesPrice = parseFloat(market.bestAsk ?? "0") * 100;
    }

    let yesTokenId = "";
    let noTokenId = "";
    try {
      const tokenIds =
        typeof market.clobTokenIds === "string"
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
      yesTokenId = tokenIds?.[0] ?? "";
      noTokenId = tokenIds?.[1] ?? "";
    } catch {
      /* ignore */
    }

    return {
      conditionId: market.conditionId ?? market.condition_id ?? "",
      question: market.question ?? market.description ?? "",
      marketSlug: market.slug ?? "",
      yesPrice: Math.round(yesPrice * 100) / 100,
      yesTokenId,
      noPrice: Math.round(noPrice * 100) / 100,
      noTokenId,
      negRisk: Boolean(market.negRisk ?? event.negRisk ?? false),
    };
  });
}

export async function getYesPrices(slug: string): Promise<MarketPrice[]> {
  const response = await axios.get(`${GAMMA_API_URL}/events/slug/${slug}`);
  const event = response.data;

  const markets: any[] = event.markets ?? [];

  return markets.map((market) => {
    const yesToken = market.outcomes
      ? market.outcomePrices
        ? JSON.parse(market.outcomePrices)?.[0]
        : undefined
      : undefined;

    const yesPrice = parseFloat(yesToken ?? market.bestAsk ?? "0") * 100;

    let yesTokenId = "";
    try {
      const tokenIds = typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      yesTokenId = tokenIds?.[0] ?? "";
    } catch {
      yesTokenId = "";
    }

    return {
      conditionId: market.conditionId ?? market.condition_id ?? "",
      question: market.question ?? market.description ?? "",
      yesPrice: Math.round(yesPrice * 100) / 100,
      yesTokenId,
    };
  });
}
