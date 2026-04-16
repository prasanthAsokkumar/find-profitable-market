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
  hours_left_at_entry: number | null;
  opened_at: string;
}

export async function getOpenPositions(eventId: number): Promise<Map<string, Position>> {
  const result = await pool.query(
    `SELECT condition_id, event_id, question, yes_token_id,
            entry_price, shares, cost_usd, neg_risk, status,
            hours_left_at_entry, opened_at
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
      hours_left_at_entry: row.hours_left_at_entry === null ? null : Number(row.hours_left_at_entry),
      opened_at: row.opened_at,
    });
  }
  return map;
}

export async function getOpenPosition(conditionId: string): Promise<Position | null> {
  const result = await pool.query(
    `SELECT condition_id, event_id, question, yes_token_id,
            entry_price, shares, cost_usd, neg_risk, status,
            hours_left_at_entry, opened_at
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
    hours_left_at_entry: row.hours_left_at_entry === null ? null : Number(row.hours_left_at_entry),
    opened_at: row.opened_at,
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
  hoursLeftAtEntry: number | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO positions
       (condition_id, event_id, question, yes_token_id,
        entry_price, shares, cost_usd, neg_risk, status,
        hours_left_at_entry, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', $9, NOW())
     ON CONFLICT (condition_id) DO UPDATE SET
        entry_price         = EXCLUDED.entry_price,
        shares              = EXCLUDED.shares,
        cost_usd            = EXCLUDED.cost_usd,
        status              = 'OPEN',
        hours_left_at_entry = EXCLUDED.hours_left_at_entry,
        opened_at           = NOW(),
        closed_at           = NULL`,
    [
      p.conditionId,
      p.eventId,
      p.question,
      p.yesTokenId,
      p.entryPrice,
      p.shares,
      p.costUsd,
      p.negRisk,
      p.hoursLeftAtEntry,
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

export async function insertTrade(t: {
  conditionId: string;
  eventId: number;
  question: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  costUsd: number;
  proceedsUsd: number;
  plUsd: number;
  exitReason: string;
  hoursLeftAtEntry: number | null;
  holdMinutes: number | null;
  openedAt: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO trades
       (condition_id, event_id, question, entry_price, exit_price,
        shares, cost_usd, proceeds_usd, pl_usd, exit_reason,
        hours_left_at_entry, hold_minutes, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      t.conditionId,
      t.eventId,
      t.question,
      t.entryPrice,
      t.exitPrice,
      t.shares,
      t.costUsd,
      t.proceedsUsd,
      t.plUsd,
      t.exitReason,
      t.hoursLeftAtEntry,
      t.holdMinutes,
      t.openedAt,
    ]
  );
}

export interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  avgPl: number;
  avgWin: number;
  avgLoss: number;
}

const STATS_SELECT = `
  COUNT(*)::int                                              AS total,
  COUNT(*) FILTER (WHERE pl_usd > 0)::int                    AS wins,
  COUNT(*) FILTER (WHERE pl_usd <= 0)::int                   AS losses,
  COALESCE(SUM(pl_usd), 0)::float                            AS total_pl,
  COALESCE(AVG(pl_usd), 0)::float                            AS avg_pl,
  COALESCE(AVG(pl_usd) FILTER (WHERE pl_usd > 0), 0)::float  AS avg_win,
  COALESCE(AVG(pl_usd) FILTER (WHERE pl_usd <= 0), 0)::float AS avg_loss
`;

function rowToStats(row: any): TradeStats {
  const total = Number(row.total);
  const wins = Number(row.wins);
  return {
    total,
    wins,
    losses: Number(row.losses),
    winRate: total > 0 ? wins / total : 0,
    totalPl: Number(row.total_pl),
    avgPl: Number(row.avg_pl),
    avgWin: Number(row.avg_win),
    avgLoss: Number(row.avg_loss),
  };
}

export async function getTradeStats(): Promise<TradeStats> {
  const r = await pool.query(`SELECT ${STATS_SELECT} FROM trades`);
  return rowToStats(r.rows[0]);
}

export interface BucketedStats extends TradeStats {
  bucket: string;
}

// Win rate / P&L grouped by entry-price bucket. Tells you which part of the
// 70–97 band is actually profitable so you can tighten PRICE_MIN over time.
export async function getStatsByEntryPriceBucket(): Promise<BucketedStats[]> {
  const r = await pool.query(
    `SELECT
       CASE
         WHEN entry_price < 75 THEN '70-74¢'
         WHEN entry_price < 80 THEN '75-79¢'
         WHEN entry_price < 85 THEN '80-84¢'
         WHEN entry_price < 90 THEN '85-89¢'
         WHEN entry_price < 95 THEN '90-94¢'
         ELSE                        '95-97¢'
       END AS bucket,
       MIN(entry_price) AS sort_key,
       ${STATS_SELECT}
     FROM trades
     GROUP BY bucket
     ORDER BY sort_key`
  );
  return r.rows.map((row) => ({ bucket: row.bucket, ...rowToStats(row) }));
}

// Win rate / P&L grouped by hours-left-at-entry. Tells you whether later
// entries really do outperform, validating (or killing) ENTRY_MAX_HOURS_LEFT.
export async function getStatsByHoursLeftBucket(): Promise<BucketedStats[]> {
  const r = await pool.query(
    `SELECT
       CASE
         WHEN hours_left_at_entry IS NULL THEN 'unknown'
         WHEN hours_left_at_entry < 1   THEN '<1h'
         WHEN hours_left_at_entry < 2   THEN '1-2h'
         WHEN hours_left_at_entry < 4   THEN '2-4h'
         WHEN hours_left_at_entry < 6   THEN '4-6h'
         ELSE                                '6h+'
       END AS bucket,
       MIN(COALESCE(hours_left_at_entry, 999)) AS sort_key,
       ${STATS_SELECT}
     FROM trades
     GROUP BY bucket
     ORDER BY sort_key`
  );
  return r.rows.map((row) => ({ bucket: row.bucket, ...rowToStats(row) }));
}

// Breakdown by how the trade exited — is the stop or the take-profit pulling its weight?
export async function getStatsByExitReason(): Promise<BucketedStats[]> {
  const r = await pool.query(
    `SELECT exit_reason AS bucket, ${STATS_SELECT}
       FROM trades
      GROUP BY exit_reason
      ORDER BY exit_reason`
  );
  return r.rows.map((row) => ({ bucket: row.bucket, ...rowToStats(row) }));
}

// ─────────────────────────────────────────────────────────────
// Dip watches (Telegram-initiated cheap-price buy orders)
// ─────────────────────────────────────────────────────────────

export interface DipWatch {
  id: number;
  event_slug: string;
  market_slug: string;
  side: "YES" | "NO";
  max_usd: number;
  threshold_cents: number;
  status: string;
  created_at: string;
}

export async function insertDipWatch(w: {
  eventSlug: string;
  marketSlug: string;
  side: "YES" | "NO";
  maxUsd: number;
  thresholdCents: number;
}): Promise<DipWatch> {
  const r = await pool.query(
    `INSERT INTO dip_watches (event_slug, market_slug, side, max_usd, threshold_cents)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, event_slug, market_slug, side, max_usd, threshold_cents, status, created_at`,
    [w.eventSlug, w.marketSlug, w.side, w.maxUsd, w.thresholdCents]
  );
  const row = r.rows[0];
  return {
    ...row,
    max_usd: Number(row.max_usd),
    threshold_cents: Number(row.threshold_cents),
  };
}

export async function getActiveDipWatches(): Promise<DipWatch[]> {
  const r = await pool.query(
    `SELECT id, event_slug, market_slug, side, max_usd, threshold_cents, status, created_at
       FROM dip_watches
      WHERE status = 'active'
      ORDER BY id`
  );
  return r.rows.map((row) => ({
    ...row,
    max_usd: Number(row.max_usd),
    threshold_cents: Number(row.threshold_cents),
  }));
}

export async function markDipWatchFilled(
  id: number,
  fillPrice: number,
  orderId: string
): Promise<void> {
  await pool.query(
    `UPDATE dip_watches
        SET status = 'filled', filled_at = NOW(), fill_price = $2, order_id = $3
      WHERE id = $1`,
    [id, fillPrice, orderId]
  );
}

export async function markDipWatchFailed(id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE dip_watches SET status = 'failed', error = $2 WHERE id = $1`,
    [id, error]
  );
}

export async function cancelDipWatch(
  marketSlug: string,
  side?: "YES" | "NO"
): Promise<number> {
  const r = side
    ? await pool.query(
        `UPDATE dip_watches SET status = 'cancelled'
          WHERE status = 'active' AND market_slug = $1 AND side = $2`,
        [marketSlug, side]
      )
    : await pool.query(
        `UPDATE dip_watches SET status = 'cancelled'
          WHERE status = 'active' AND market_slug = $1`,
        [marketSlug]
      );
  return r.rowCount ?? 0;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
