import { Pool } from "pg";

const pool = new Pool();

export interface Event {
  id: number;
  poly_event_id: string;
  slug: string;
  title: string;
  end_date: string | null;
  neg_risk: boolean;
}

export async function getEvents(): Promise<Event[]> {
  // Only fetch events ending within the next 24h (and not already ended).
  const result = await pool.query<Event>(
    `SELECT id, poly_event_id, slug, title, end_date, neg_risk
       FROM events
      WHERE active = true
        AND closed = false
        AND end_date IS NOT NULL
        AND end_date > NOW()
        AND end_date <= NOW() + INTERVAL '24 hours'`
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

export interface Position {
  condition_id: string;
  event_id: number;
  question: string;
  yes_token_id: string;
  entry_price: number;
  shares: number;
  cost_usd: number;
  neg_risk: boolean;
  status: string;
}

export async function getOpenPositions(eventId: number): Promise<Map<string, Position>> {
  const result = await pool.query(
    `SELECT condition_id, event_id, question, yes_token_id,
            entry_price, shares, cost_usd, neg_risk, status
       FROM positions
      WHERE event_id = $1 AND status = 'OPEN'`,
    [eventId]
  );
  const map = new Map<string, Position>();
  for (const row of result.rows) {
    map.set(row.condition_id, {
      condition_id: row.condition_id,
      event_id: row.event_id,
      question: row.question,
      yes_token_id: row.yes_token_id,
      entry_price: Number(row.entry_price),
      shares: Number(row.shares),
      cost_usd: Number(row.cost_usd),
      neg_risk: row.neg_risk,
      status: row.status,
    });
  }
  return map;
}

export async function getOpenPosition(conditionId: string): Promise<Position | null> {
  const result = await pool.query(
    `SELECT condition_id, event_id, question, yes_token_id,
            entry_price, shares, cost_usd, neg_risk, status
       FROM positions
      WHERE condition_id = $1 AND status = 'OPEN'`,
    [conditionId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    condition_id: row.condition_id,
    event_id: row.event_id,
    question: row.question,
    yes_token_id: row.yes_token_id,
    entry_price: Number(row.entry_price),
    shares: Number(row.shares),
    cost_usd: Number(row.cost_usd),
    neg_risk: row.neg_risk,
    status: row.status,
  };
}

export async function insertPosition(p: {
  conditionId: string;
  eventId: number;
  question: string;
  yesTokenId: string;
  entryPrice: number;
  shares: number;
  costUsd: number;
  negRisk: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO positions
       (condition_id, event_id, question, yes_token_id,
        entry_price, shares, cost_usd, neg_risk, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', NOW())
     ON CONFLICT (condition_id) DO UPDATE SET
        entry_price = EXCLUDED.entry_price,
        shares      = EXCLUDED.shares,
        cost_usd    = EXCLUDED.cost_usd,
        status      = 'OPEN',
        opened_at   = NOW(),
        closed_at   = NULL`,
    [
      p.conditionId,
      p.eventId,
      p.question,
      p.yesTokenId,
      p.entryPrice,
      p.shares,
      p.costUsd,
      p.negRisk,
    ]
  );
}

export async function closePosition(conditionId: string): Promise<void> {
  await pool.query(
    `UPDATE positions
        SET status = 'CLOSED', closed_at = NOW()
      WHERE condition_id = $1`,
    [conditionId]
  );
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
