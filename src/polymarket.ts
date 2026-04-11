import axios from "axios";

const API_URL = process.env.POLYMARKET_API_URL || "https://clob.polymarket.com";

export interface MarketPrice {
  conditionId: string;
  question: string;
  yesPrice: number;
}

export async function getYesPrices(polyEventId: string): Promise<MarketPrice[]> {
  const response = await axios.get(`${API_URL}/markets`, {
    params: { event_id: polyEventId },
  });

  const markets: any[] = Array.isArray(response.data) ? response.data : response.data.data ?? [];

  return markets.map((market) => {
    const yesToken = market.tokens?.find(
      (t: any) => t.outcome?.toLowerCase() === "yes"
    );
    const yesPrice = parseFloat(yesToken?.price ?? "0") * 100;

    return {
      conditionId: market.condition_id,
      question: market.question ?? market.description ?? "",
      yesPrice: Math.round(yesPrice * 100) / 100,
    };
  });
}
