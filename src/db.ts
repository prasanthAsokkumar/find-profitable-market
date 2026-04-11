import { Pool } from "pg";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

export interface Event {
  id: number;
  poly_event_id: string;
  slug: string;
  title: string;
}

export async function getEvents(): Promise<Event[]> {
  const result = await pool.query<Event>(
    "SELECT id, poly_event_id, slug, title FROM events WHERE active = true AND closed = false"
  );
  return result.rows;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
