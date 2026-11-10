import { parseIcal, formatLocal } from './ical.js';
import { diffMatches, splitTeams, clubKey, clubDisplay, inferOwnTeam } from './sync.js';
import { ADMIN_HTML, EMBED_JS } from './assets.js';

const MAX_LOGO_BYTES = 300 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const CORS = { 'access-control-allow-origin': '*' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function allowedHosts(env) {
  return String(env.ALLOWED_HOSTS || 'data.sportlink.com').split(',').map((s) => s.trim()).filter(Boolean);
}

function validateUrl(env, raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new HttpError(400, 'Dit is geen geldige link.'); }
  const hosts = allowedHosts(env);
  const httpOk = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
  if (!httpOk || !hosts.includes(u.hostname)) {
    throw new HttpError(400, 'Alleen links van ' + hosts.join(', ') + ' zijn toegestaan.');
  }
  return u.toString();
}

function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const token = u.searchParams.get('token');
    if (token) u.searchParams.set('token', token.slice(0, 4) + '...');
    return u.toString();
  } catch { return ''; }
}

// Teamvolgorde: eerst de nummerteams op volgorde (Rietmolen 1, 2, 3...), daarna de rest
// (dames, jeugd) alfabetisch.
const collator = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' });
function teamCompare(a, b) {
  const ga = /\s\d+$/.test(a.name) ? 0 : 1;
  const gb = /\s\d+$/.test(b.name) ? 0 : 1;
  return ga - gb || collator.compare(a.name, b.name);
}

// ---------------------------------------------------------------- synchroniseren

async function ensureClubStatements(env, names) {
  const stmts = [];
  const seen = new Set();
  for (const name of names) {
    const key = clubKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO clubs (key, display) VALUES (?, ?)').bind(key, clubDisplay(name)));
  }
  return stmts;
}

async function runBatches(env, stmts) {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// Haalt de feed op. Doorverwijzingen volgen we zelf, en elke stap moet naar een toegestane
// host gaan. Zo bereikt de server nooit een andere website, ook niet via een redirect.
const MAX_REDIRECTS = 5;
async function fetchFeed(env, startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      headers: { 'user-agent': 'RietmolenWedstrijden/1.0', accept: 'text/calendar,*/*' },
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        current = validateUrl(env, new URL(location, current).toString());
      } catch {
        throw new Error('De link stuurde door naar een niet toegestane website.');
      }
      continue;
    }
    return res;
  }
  throw new Error('De link stuurde te vaak door.');
}

export async function syncTeam(env, team) {
  const t = nowIso();
  try {
    const res = await fetchFeed(env, team.ical_url);
    if (!res.ok) throw new Error('Voetbal.nl gaf foutcode ' + res.status);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Het antwoord is geen agenda (iCal) bestand. Is de link nog geldig?');

    const { calendarName, events } = parseIcal(text);
    let name = team.name;
    if (!name) name = calendarName.replace(/^voetbal\.nl\s*-\s*/i, '').trim() || 'Team ' + team.id;

    const existing = (await env.DB.prepare('SELECT * FROM matches WHERE team_id = ?').bind(team.id).all()).results;
    const diff = diffMatches(existing, events, t);
    const ownTeam = inferOwnTeam(events.map((e) => e.summary), name);
    const logChanges = !!team.last_ok_at;
    const stmts = [];

    const clubNames = [];
    const insertMatch = env.DB.prepare(
      `INSERT INTO matches (team_id, uid, summary, home, away, home_key, away_key, start_utc, end_utc, location, description, status, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChange = env.DB.prepare(
      'INSERT INTO changes (team_id, match_id, label, kind, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    for (const ev of diff.inserts) {
      const sp = splitTeams(ev.summary, ownTeam);
      clubNames.push(sp.home, sp.away);
      stmts.push(insertMatch.bind(team.id, ev.uid, ev.summary, sp.home, sp.away, clubKey(sp.home), clubKey(sp.away),
        ev.startUtc, ev.endUtc, ev.location, ev.description, ev.status, t, t));
      if (logChanges) stmts.push(insertChange.bind(team.id, null, ev.summary, 'new', 'start', '', ev.startUtc, t));
    }

    const COLS = ['summary', 'start_utc', 'end_utc', 'location', 'description', 'status', 'uid', 'removed_at'];
    for (const u of diff.updates) {
      const sets = [];
      const args = [];
      for (const col of COLS) {
        if (col in u.fields) { sets.push(col + ' = ?'); args.push(u.fields[col]); }
      }
      if ('summary' in u.fields) {
        const sp = splitTeams(u.fields.summary, ownTeam);
        clubNames.push(sp.home, sp.away);
        sets.push('home = ?', 'away = ?', 'home_key = ?', 'away_key = ?');
        args.push(sp.home, sp.away, clubKey(sp.home), clubKey(sp.away));
      }
      const startChange = u.changes.find((c) => c.field === 'start');
      if (startChange) {
        // Terug op de oorspronkelijke tijd? Dan is het niet langer "verplaatst".
        sets.push('previous_start_utc = CASE WHEN previous_start_utc = ? THEN NULL ELSE ? END');
        args.push(startChange.new, startChange.old);
      }
      sets.push('sequence = sequence + 1', 'updated_at = ?');
      args.push(t, u.id);
      stmts.push(env.DB.prepare('UPDATE matches SET ' + sets.join(', ') + ' WHERE id = ?').bind(...args));
      for (const c of u.changes) stmts.push(insertChange.bind(team.id, u.id, u.label, c.kind, c.field, c.old, c.new, t));
    }

    for (const r of diff.removals) {
      stmts.push(env.DB.prepare('UPDATE matches SET removed_at = ?, updated_at = ?, sequence = sequence + 1 WHERE id = ?').bind(t, t, r.id));
      for (const c of r.changes) stmts.push(insertChange.bind(team.id, r.id, r.label, c.kind, c.field, c.old, c.new, t));
    }

    const clubStmts = await ensureClubStatements(env, clubNames);
    const status = diff.warnings.length ? 'warning' : 'ok';
    const teamStmt = env.DB.prepare(
      'UPDATE teams SET name = ?, last_sync_at = ?, last_ok_at = ?, last_status = ?, last_error = ? WHERE id = ?'
    ).bind(name, t, t, status, diff.warnings.join(' ') || null, team.id);

    await runBatches(env, [...clubStmts, ...stmts, teamStmt]);
    return {
      teamId: team.id, name, ok: true,
      inserted: diff.inserts.length, updated: diff.updates.length, removed: diff.removals.length,
      unchanged: diff.unchanged, warnings: diff.warnings,
    };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    await env.DB.prepare('UPDATE teams SET last_sync_at = ?, last_status = ?, last_error = ? WHERE id = ?')
      .bind(t, 'error', message, team.id).run();
    return { teamId: team.id, name: team.name, ok: false, error: message };
  }
}

export async function syncAll(env, limit) {
  const max = limit || parseInt(env.MAX_TEAMS_PER_RUN || '40', 10);
  // Oudst gesynchroniseerde teams eerst, zodat bij veel teams iedereen aan de beurt komt.
  const teams = (await env.DB.prepare(
    'SELECT * FROM teams WHERE active = 1 ORDER BY COALESCE(last_sync_at, \'\') ASC LIMIT ?'
  ).bind(max).all()).results;
  const results = [];
  for (const team of teams) results.push(await syncTeam(env, team));
  return results;
}

async function resplitTeam(env, teamId, name) {
  const rows = (await env.DB.prepare('SELECT id, summary FROM matches WHERE team_id = ?').bind(teamId).all()).results;
  const stmts = [];
  const names = [];
  const ownTeam = inferOwnTeam(rows.map((r) => r.summary), name);
  for (const r of rows) {
    const sp = splitTeams(r.summary, ownTeam);
    names.push(sp.home, sp.away);
    stmts.push(env.DB.prepare('UPDATE matches SET home = ?, away = ?, home_key = ?, away_key = ? WHERE id = ?')
      .bind(sp.home, sp.away, clubKey(sp.home), clubKey(sp.away), r.id));
  }
  await runBatches(env, [...(await ensureClubStatements(env, names)), ...stmts]);
}

// ---------------------------------------------------------------- wedstrijden opvragen

async function queryMatches(env, opts) {
  const where = [];
  const args = [];
  if (!opts.includeRemoved) where.push('m.removed_at IS NULL');
  if (!opts.includeInactive) where.push('t.active = 1');
  if (opts.teamId) { where.push('m.team_id = ?'); args.push(opts.teamId); }
  if (opts.upcoming) { where.push('m.end_utc >= ?'); args.push(nowIso()); }
  if (opts.from) { where.push('m.start_utc >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('m.start_utc <= ?'); args.push(opts.to); }
  const limit = Math.min(Math.max(parseInt(opts.limit || '500', 10) || 500, 1), 1000);
  const sql = `SELECT m.*, t.name AS team_name,
      ch.id AS home_club_id, ch.display AS home_club, ch.logo_version AS home_lv, (ch.logo_b64 IS NOT NULL) AS home_has_logo,
      ca.id AS away_club_id, ca.display AS away_club, ca.logo_version AS away_lv, (ca.logo_b64 IS NOT NULL) AS away_has_logo
    FROM matches m
    JOIN teams t ON t.id = m.team_id
    LEFT JOIN clubs ch ON ch.key = m.home_key
    LEFT JOIN clubs ca ON ca.key = m.away_key
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.start_utc ASC LIMIT ?`;
  args.push(limit);
  return (await env.DB.prepare(sql).bind(...args).all()).results;
}

// Onderlinge wedstrijden (bijvoorbeeld Rietmolen 4-Rietmolen 5) staan in de feed van
// beide teams. In de gezamenlijke feed tonen we ze maar een keer.
export function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = r.summary.toLowerCase() + '|' + r.start_utc;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function shapeMatch(row, origin) {
  const side = (name, clubId, club, lv, has) => ({
    name,
    club: club || clubDisplay(name),
    clubId: clubId || null,
    logo: has && clubId ? origin + '/logo/' + clubId + '?v=' + lv : null,
  });
  return {
    id: row.id,
    teamId: row.team_id,
    team: row.team_name,
    home: side(row.home, row.home_club_id, row.home_club, row.home_lv, row.home_has_logo),
    away: side(row.away, row.away_club_id, row.away_club, row.away_lv, row.away_has_logo),
    summary: row.summary,
    start: row.start_utc,
    startLocal: formatLocal(row.start_utc),
    end: row.end_utc,
    location: row.location,
    competition: row.description,
    status: row.removed_at ? 'removed' : row.status,
    rescheduled: !!row.previous_start_utc,
    previousStart: row.previous_start_utc || null,
    previousStartLocal: row.previous_start_utc ? formatLocal(row.previous_start_utc) : null,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------- ICS

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// iCal-regels mogen 75 bytes (niet tekens) zijn. Vervolgregels beginnen met een spatie.
const encoder = new TextEncoder();
export function fold(line) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of String(line)) {
    const bytes = encoder.encode(ch).length;
    const max = out.length === 0 ? 75 : 74;
    if (curBytes + bytes > max) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch;
    curBytes += bytes;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}
const icsDate = (iso) => iso.replace(/[-:]/g, '');

function buildIcs(rows, host, calName) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rietmolen//Wedstrijden//NL', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:' + icsEscape(calName), 'X-WR-TIMEZONE:Europe/Amsterdam',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
  ];
  for (const m of rows) {
    const cancelled = m.status === 'cancelled';
    const desc = [m.team_name, m.description];
    if (m.previous_start_utc) desc.push('Verplaatst, was ' + formatLocal(m.previous_start_utc).replace('T', ' '));
    lines.push(
      'BEGIN:VEVENT',
      'UID:match-' + m.id + '@' + host,
      'DTSTAMP:' + icsDate(m.updated_at),
      'DTSTART:' + icsDate(m.start_utc),
      'DTEND:' + icsDate(m.end_utc),
      'SUMMARY:' + icsEscape((cancelled ? 'AFGELAST: ' : '') + m.summary),
      'LOCATION:' + icsEscape(m.location),
      'DESCRIPTION:' + icsEscape(desc.filter(Boolean).join(' | ')),
      'SEQUENCE:' + m.sequence,
      'STATUS:' + (cancelled ? 'CANCELLED' : 'CONFIRMED'),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- logo's

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function serveLogo(env, id) {
  const row = await env.DB.prepare('SELECT logo_b64, logo_type FROM clubs WHERE id = ?').bind(id).first();
  if (!row || !row.logo_b64) return new Response('Geen logo', { status: 404 });
  const bin = atob(row.logo_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'content-type': row.logo_type || 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...CORS,
      'cross-origin-resource-policy': 'cross-origin',
    },
  });
}

// ---------------------------------------------------------------- beheer

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function authCheck(request, env) {
  if (!env.ADMIN_PASSWORD) return new Response('ADMIN_PASSWORD is nog niet ingesteld. Zie de README.', { status: 503 });
  const h = request.headers.get('authorization') || '';
  let ok = false;
  if (h.startsWith('Basic ')) {
    try {
      const decoded = atob(h.slice(6));
      ok = safeEqual(decoded.slice(decoded.indexOf(':') + 1), env.ADMIN_PASSWORD);
    } catch { ok = false; }
  }
  if (!ok) {
    return new Response('Inloggen vereist', { status: 401, headers: { 'www-authenticate': 'Basic realm="Rietmolen wedstrijden beheer", charset="UTF-8"' } });
  }
  return null;
}

async function adminState(env) {
  const teams = (await env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM matches m WHERE m.team_id = t.id AND m.removed_at IS NULL) AS match_count
     FROM teams t ORDER BY t.name COLLATE NOCASE`
  ).all()).results.map((t) => ({
    id: t.id, name: t.name, url: maskUrl(t.ical_url), active: !!t.active, matchCount: t.match_count,
    lastSyncAt: t.last_sync_at, lastOkAt: t.last_ok_at, status: t.last_status, error: t.last_error,
  }));
  const clubs = (await env.DB.prepare(
    `SELECT c.id, c.key, c.display, c.logo_version, (c.logo_b64 IS NOT NULL) AS has_logo,
       (SELECT COUNT(*) FROM matches m WHERE m.home_key = c.key OR m.away_key = c.key) AS match_count
     FROM clubs c ORDER BY c.display COLLATE NOCASE`
  ).all()).results.map((c) => ({
    id: c.id, key: c.key, display: c.display, hasLogo: !!c.has_logo, version: c.logo_version, matchCount: c.match_count,
  }));
  const changes = (await env.DB.prepare(
    `SELECT c.*, t.name AS team_name FROM changes c LEFT JOIN teams t ON t.id = c.team_id
     ORDER BY c.id DESC LIMIT 200`
  ).all()).results.map((c) => ({
    id: c.id, team: c.team_name, label: c.label, kind: c.kind, field: c.field, old: c.old_value, new: c.new_value, at: c.changed_at,
  }));
  return { teams: teams.sort(teamCompare), clubs, changes, now: nowIso() };
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Ongeldige invoer.'); }
}

async function handleAdminApi(request, env, url, origin) {
  const path = url.pathname.replace(/^\/admin\/api/, '');
  const method = request.method;
  if (method !== 'GET' && request.headers.get('x-requested-with') !== 'rietmolen-admin') {
    throw new HttpError(403, 'Ongeldig verzoek.');
  }
  let m;

  if (method === 'GET' && path === '/state') return json(await adminState(env));

  if (method === 'GET' && path === '/matches') {
    const rows = await queryMatches(env, {
      teamId: parseInt(url.searchParams.get('team') || '0', 10) || 0,
      includeRemoved: true, includeInactive: true, limit: 1000,
    });
    return json({ matches: rows.map((r) => shapeMatch(r, origin)) });
  }

  if (method === 'POST' && path === '/teams') {
    const body = await readJson(request);
    const icalUrl = validateUrl(env, body.url);
    const dup = await env.DB.prepare('SELECT id FROM teams WHERE ical_url = ?').bind(icalUrl).first();
    if (dup) throw new HttpError(409, 'Deze link staat er al in.');
    const r = await env.DB.prepare('INSERT INTO teams (name, ical_url, created_at) VALUES (?, ?, ?)')
      .bind(String(body.name || '').trim(), icalUrl, nowIso()).run();
    const team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(r.meta.last_row_id).first();
    return json({ sync: await syncTeam(env, team) }, 201);
  }

  if ((m = path.match(/^\/teams\/(\d+)$/))) {
    const id = parseInt(m[1], 10);
    const team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first();
    if (!team) throw new HttpError(404, 'Team niet gevonden.');
    if (method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body.active === 'boolean') {
        await env.DB.prepare('UPDATE teams SET active = ? WHERE id = ?').bind(body.active ? 1 : 0, id).run();
      }
      if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== team.name) {
        await env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(body.name.trim(), id).run();
        await resplitTeam(env, id, body.name.trim());
      }
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM changes WHERE team_id = ?').bind(id),
        env.DB.prepare('DELETE FROM matches WHERE team_id = ?').bind(id),
        env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if (method === 'POST' && path === '/sync') {
    const body = await readJson(request).catch(() => ({}));
    if (body.teamId) {
      const team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(parseInt(body.teamId, 10)).first();
      if (!team) throw new HttpError(404, 'Team niet gevonden.');
      return json({ results: [await syncTeam(env, team)] });
    }
    return json({ results: await syncAll(env) });
  }

  if ((m = path.match(/^\/clubs\/(\d+)$/)) && method === 'PATCH') {
    const body = await readJson(request);
    const display = String(body.display || '').trim();
    if (!display) throw new HttpError(400, 'Naam mag niet leeg zijn.');
    await env.DB.prepare('UPDATE clubs SET display = ? WHERE id = ?').bind(display, parseInt(m[1], 10)).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/clubs\/(\d+)\/logo$/))) {
    const id = parseInt(m[1], 10);
    if (method === 'PUT') {
      const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!LOGO_TYPES.includes(type)) throw new HttpError(400, 'Gebruik PNG, JPG, WebP of SVG.');
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO_BYTES) throw new HttpError(400, 'Het logo mag maximaal 300 KB zijn.');
      await env.DB.prepare('UPDATE clubs SET logo_b64 = ?, logo_type = ?, logo_version = logo_version + 1 WHERE id = ?')
        .bind(toB64(buf), type, id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE clubs SET logo_b64 = NULL, logo_type = NULL, logo_version = logo_version + 1 WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Onbekend adres.');
}

// ---------------------------------------------------------------- router

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const origin = originOf(request, url);
  const p = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' } });
  }

  if (p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/')) {
    const denied = authCheck(request, env);
    if (denied) return denied;
    if (p.startsWith('/admin/api/')) return handleAdminApi(request, env, url, origin);
    return new Response(ADMIN_HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' },
    });
  }

  if (p === '/api/cron/sync') {
    if (!env.CRON_SECRET) throw new HttpError(503, 'CRON_SECRET is niet ingesteld.');
    const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(got, env.CRON_SECRET)) throw new HttpError(401, 'Geen toegang.');
    const results = await syncAll(env);
    return json({ ok: results.every((r) => r.ok), results });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Niet toegestaan.');

  // Publieke feeds verversen zichzelf: is een team ouder dan 15 minuten, dan halen we het
  // op de achtergrond opnieuw op. Zo werkt het ook zonder tijdgestuurde taak.
  if (p === '/api/matches' || p === '/feed.ics') ctx.waitUntil(refreshStale(env));

  let m;
  if (p === '/api/teams') {
    const rows = (await env.DB.prepare('SELECT id, name FROM teams WHERE active = 1 ORDER BY name COLLATE NOCASE').all()).results;
    return json({ teams: rows.sort(teamCompare) }, 200, { ...CORS, 'cache-control': 'public, max-age=300' });
  }

  if (p === '/api/matches') {
    // Eerst ontdubbelen, daarna pas afkappen. Anders telt een dubbele wedstrijd mee in de limiet.
    const want = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 1000);
    const rows = await queryMatches(env, {
      teamId: parseInt(url.searchParams.get('team') || '0', 10) || 0,
      upcoming: url.searchParams.get('upcoming') === '1',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      limit: 1000,
      includeRemoved: url.searchParams.get('include') === 'removed',
    });
    const matches = dedupe(rows).slice(0, want).map((r) => shapeMatch(r, origin));
    return json({ generatedAt: nowIso(), matches }, 200,
      { ...CORS, 'cache-control': 'public, max-age=120' });
  }

  if (p === '/feed.ics') {
    const teamId = parseInt(url.searchParams.get('team') || '0', 10) || 0;
    const rows = await queryMatches(env, { teamId });
    let name = 'Rietmolen wedstrijden';
    if (teamId && rows[0]) name = rows[0].team_name + ' wedstrijden';
    return new Response(buildIcs(dedupe(rows), new URL(origin).hostname, name), {
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS },
    });
  }

  if ((m = p.match(/^\/logo\/(\d+)$/))) return serveLogo(env, parseInt(m[1], 10));

  if (p === '/embed.js') {
    return new Response(EMBED_JS, {
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS },
    });
  }

  if (p === '/') {
    return new Response('Rietmolen wedstrijden\n\n/api/matches\n/feed.ics\n/embed.js\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  throw new HttpError(404, 'Niet gevonden.');
}

// ---------------------------------------------------------------- verversen en ingang

const STALE_MINUTES = 15;
let lastStaleCheck = 0;

export async function refreshStale(env) {
  // Per serverinstantie hooguit eens per minuut kijken, om de database te sparen.
  if (Date.now() - lastStaleCheck < 60000) return;
  lastStaleCheck = Date.now();
  try {
    const cutoff = new Date(Date.now() - STALE_MINUTES * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const limit = parseInt(env.MAX_TEAMS_PER_RUN || '40', 10);
    const due = (await env.DB.prepare(
      "SELECT * FROM teams WHERE active = 1 AND (last_sync_at IS NULL OR last_sync_at < ?) ORDER BY COALESCE(last_sync_at, '') ASC LIMIT ?"
    ).bind(cutoff, limit).all()).results;
    for (const team of due) {
      // Eerst claimen, zodat twee gelijktijdige bezoekers niet beide hetzelfde team ophalen.
      const claim = await env.DB.prepare(
        'UPDATE teams SET last_sync_at = ? WHERE id = ? AND (last_sync_at IS NULL OR last_sync_at < ?)'
      ).bind(nowIso(), team.id, cutoff).run();
      if (claim.meta.changes !== 1) continue;
      await syncTeam(env, team);
    }
  } catch (err) {
    console.error('Verversen mislukt', err);
  }
}

function originOf(request, url) {
  const proto = (request.headers.get('x-forwarded-proto') || '').split(',')[0].trim() || url.protocol.replace(':', '');
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host).split(',')[0].trim();
  return proto + '://' + host;
}

export async function handleRequest(request, env, ctx) {
  try {
    return await handle(request, env, ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Er ging iets mis op de server.' }, 500);
  }
}
