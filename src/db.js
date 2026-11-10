import { createClient } from '@libsql/client';

// Database-laag: een kleine adapter die @libsql/client (Turso of een lokaal SQLite-bestand)
// dezelfde vorm geeft als prepare().bind().all()/first()/run() en batch(), zodat de rest van
// de code er niets van merkt.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  ical_url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_ok_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  display TEXT NOT NULL,
  logo_b64 TEXT,
  logo_type TEXT,
  logo_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  summary TEXT NOT NULL,
  home TEXT NOT NULL DEFAULT '',
  away TEXT NOT NULL DEFAULT '',
  home_key TEXT NOT NULL DEFAULT '',
  away_key TEXT NOT NULL DEFAULT '',
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  previous_start_utc TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_matches_team ON matches(team_id);
CREATE INDEX IF NOT EXISTS idx_matches_start ON matches(start_utc);
CREATE INDEX IF NOT EXISTS idx_matches_uid ON matches(team_id, uid);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  match_id INTEGER,
  label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  field TEXT NOT NULL DEFAULT '',
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_time ON changes(changed_at);
`;

function toObject(columns, row) {
  const o = {};
  columns.forEach((c, i) => { o[c] = row[i]; });
  return o;
}

function makeStatement(client, sql, args) {
  return {
    sql,
    args,
    bind: (...a) => makeStatement(client, sql, a),
    async all() {
      const r = await client.execute({ sql, args });
      return { results: r.rows.map((row) => toObject(r.columns, row)) };
    },
    async first() {
      const r = await client.execute({ sql, args });
      return r.rows.length ? toObject(r.columns, r.rows[0]) : null;
    },
    async run() {
      const r = await client.execute({ sql, args });
      return { meta: { last_row_id: Number(r.lastInsertRowid || 0), changes: r.rowsAffected } };
    },
  };
}

export function createDb(client) {
  return {
    prepare: (sql) => makeStatement(client, sql, []),
    async batch(stmts) {
      await client.batch(stmts.map((s) => ({ sql: s.sql, args: s.args })), 'write');
    },
  };
}

let dbPromise = null;

// Eenmaal per serverinstantie: verbinden en zo nodig de tabellen aanmaken.
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:local.db';
      const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
      await client.executeMultiple(SCHEMA);
      return createDb(client);
    })().catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

export async function makeEnv() {
  return {
    DB: await getDb(),
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    CRON_SECRET: process.env.CRON_SECRET,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || 'data.sportlink.com',
    MAX_TEAMS_PER_RUN: process.env.MAX_TEAMS_PER_RUN || '40',
  };
}
