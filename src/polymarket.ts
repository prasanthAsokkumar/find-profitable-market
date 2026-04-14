import axios from "axios";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

export interface MarketPrice {
  conditionId: string;
  question: string;
  yesPrice: number;
  yesTokenId: string;
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
