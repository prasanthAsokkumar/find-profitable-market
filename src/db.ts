import { Pool } from "pg";

const pool = new Pool();

export interface Event {
  id: number;
  poly_event_id: string;
  slug: string;
  title: string;
  end_date: string | null;
}

export async function getEvents(): Promise<Event[]> {
  const result = await pool.query<Event>(
    "SELECT id, poly_event_id, slug, title, end_date FROM events WHERE active = true AND closed = false"
  );
  return result.rows;
}

export interface MarketAlertState {
  condition_id: string;
  last_yes_price: number;
}

export async function getAlertedMarkets(eventId: number): Promise<Map<string, number>> {
  const result = await pool.query<MarketAlertState>(
    "SELECT condition_id, last_yes_price FROM market_alerts WHERE event_id = $1",
    [eventId]
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.condition_id, Number(row.last_yes_price));
  }
  return map;
}

export async function upsertMarketAlert(
  conditionId: string,
  eventId: number,
  question: string,
  yesPrice: number
): Promise<void> {
  await pool.query(
    `INSERT INTO market_alerts (condition_id, event_id, question, last_yes_price, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (condition_id)
     DO UPDATE SET last_yes_price = EXCLUDED.last_yes_price,
                   question = EXCLUDED.question,
                   updated_at = NOW()`,
    [conditionId, eventId, question, yesPrice]
  );
}

export async function deleteMarketAlert(conditionId: string): Promise<void> {
  await pool.query("DELETE FROM market_alerts WHERE condition_id = $1", [conditionId]);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
