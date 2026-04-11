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
