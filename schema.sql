CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  poly_event_id   VARCHAR(255) NOT NULL UNIQUE,
  slug            VARCHAR(255) NOT NULL UNIQUE,
  title           VARCHAR(500) NOT NULL,
  start_date      TIMESTAMPTZ,
  end_date        TIMESTAMPTZ,
  active          BOOLEAN      NOT NULL DEFAULT true,
  closed          BOOLEAN      NOT NULL DEFAULT false,
  neg_risk        BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_slug   ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_active ON events(active);

CREATE TABLE IF NOT EXISTS market_alerts (
  condition_id    VARCHAR(255) PRIMARY KEY,
  event_id        INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question        VARCHAR(1000) NOT NULL,
  last_yes_price  NUMERIC(6,2) NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_alerts_event ON market_alerts(event_id);

CREATE TABLE IF NOT EXISTS positions (
  condition_id         VARCHAR(255) PRIMARY KEY,
  event_id             INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question             VARCHAR(1000) NOT NULL,
  yes_token_id         VARCHAR(255) NOT NULL,
  entry_price          NUMERIC(6,2) NOT NULL,
  shares               NUMERIC(20,6) NOT NULL,
  cost_usd             NUMERIC(20,6) NOT NULL,
  neg_risk             BOOLEAN      NOT NULL DEFAULT true,
  status               VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  hours_left_at_entry  NUMERIC(6,2),
  opened_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at            TIMESTAMPTZ
);
-- Additive migration for existing installs:
ALTER TABLE positions ADD COLUMN IF NOT EXISTS hours_left_at_entry NUMERIC(6,2);

CREATE INDEX IF NOT EXISTS idx_positions_event  ON positions(event_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

CREATE TABLE IF NOT EXISTS trades (
  id                   SERIAL PRIMARY KEY,
  condition_id         VARCHAR(255) NOT NULL,
  event_id             INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question             VARCHAR(1000) NOT NULL,
  entry_price          NUMERIC(6,2)  NOT NULL,
  exit_price           NUMERIC(6,2)  NOT NULL,
  shares               NUMERIC(20,6) NOT NULL,
  cost_usd             NUMERIC(20,6) NOT NULL,
  proceeds_usd         NUMERIC(20,6) NOT NULL,
  pl_usd               NUMERIC(20,6) NOT NULL,
  exit_reason          VARCHAR(32)   NOT NULL,
  hours_left_at_entry  NUMERIC(6,2),
  hold_minutes         INTEGER,
  opened_at            TIMESTAMPTZ   NOT NULL,
  closed_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS hours_left_at_entry NUMERIC(6,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS hold_minutes        INTEGER;

CREATE INDEX IF NOT EXISTS idx_trades_event    ON trades(event_id);
CREATE INDEX IF NOT EXISTS idx_trades_closed   ON trades(closed_at);

-- Dip-buy watches registered via Telegram commands.
-- When a market's price drops to <= threshold_cents, we fire a single
-- market-buy for up to max_usd, then mark the watch filled.
CREATE TABLE IF NOT EXISTS dip_watches (
  id               SERIAL PRIMARY KEY,
  event_slug       VARCHAR(255) NOT NULL,
  market_slug      VARCHAR(255) NOT NULL,
  side             VARCHAR(3)   NOT NULL CHECK (side IN ('YES','NO')),
  max_usd          NUMERIC(20,6) NOT NULL,
  threshold_cents  INTEGER      NOT NULL DEFAULT 5,
  status           VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  filled_at        TIMESTAMPTZ,
  fill_price       NUMERIC(6,2),
  order_id         VARCHAR(255),
  error            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dip_watches_active
  ON dip_watches(market_slug, side)
  WHERE status = 'active';
