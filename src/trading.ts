import { OrderType, Side } from "@polymarket/clob-client";
import { getClobClient } from "./clobClient";

export interface TradeResult {
  success: boolean;
  orderId?: string;
  raw?: any;
  error?: string;
}

/**
 * Market-BUY YES tokens for a fixed USDC amount (FOK).
 * `amountUsd` is the dollar amount to spend.
 */
export async function buyYesMarket(
  yesTokenId: string,
  amountUsd: number,
  negRisk: boolean
): Promise<TradeResult> {
  try {
    const client = getClobClient();
    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: yesTokenId,
        amount: amountUsd,
        side: Side.BUY,
      },
      { tickSize: "0.01", negRisk },
      OrderType.FOK
    );
    return {
      success: resp?.success ?? true,
      orderId: resp?.orderID ?? resp?.orderId,
      raw: resp,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * Market-SELL YES tokens. `shares` is the number of conditional-token shares to sell.
 */
export async function sellYesMarket(
  yesTokenId: string,
  shares: number,
  negRisk: boolean
): Promise<TradeResult> {
  try {
    const client = getClobClient();
    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: yesTokenId,
        amount: shares,
        side: Side.SELL,
      },
      { tickSize: "0.01", negRisk },
      OrderType.FOK
    );
    return {
      success: resp?.success ?? true,
      orderId: resp?.orderID ?? resp?.orderId,
      raw: resp,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
