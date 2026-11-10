// Minimale iCal-parser voor Sportlink/Voetbal.nl feeds.
const DEFAULT_TZ = 'Europe/Amsterdam';

export function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

export function unescapeText(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1');
}

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Lokale tijd in een tijdzone naar UTC milliseconden.
export function localToUtcMs(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let zone = tz;
  try {
    tzOffsetMs(guess, zone);
  } catch {
    zone = DEFAULT_TZ;
  }
  const off1 = tzOffsetMs(guess, zone);
  let result = guess - off1;
  const off2 = tzOffsetMs(result, zone);
  if (off2 !== off1) result = guess - off2;
  return result;
}

function toIso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export function parseDateTime(value, params = {}) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) return { iso: toIso(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), allDay: false };
    const tz = params.TZID || DEFAULT_TZ;
    return { iso: toIso(localToUtcMs(+y, +mo, +d, +h, +mi, +(s || 0), tz)), allDay: false };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return { iso: toIso(localToUtcMs(+y, +mo, +d, 0, 0, 0, DEFAULT_TZ)), allDay: true };
  }
  return null;
}

// "YYYY-MM-DDTHH:MM" in Nederlandse tijd, handig voor websites.
export function formatLocal(iso, tz = DEFAULT_TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(iso))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function toEvent(raw) {
  const start = raw.DTSTART && parseDateTime(raw.DTSTART.value, raw.DTSTART.params);
  if (!start) return null;
  let end = raw.DTEND && parseDateTime(raw.DTEND.value, raw.DTEND.params);
  const startMs = Date.parse(start.iso);
  const endIso = end ? end.iso : toIso(startMs + (start.allDay ? 24 : 2) * 3600 * 1000);
  const summary = unescapeText(raw.SUMMARY && raw.SUMMARY.value).trim();
  const status = String((raw.STATUS && raw.STATUS.value) || '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'active';
  const uid = (raw.UID && raw.UID.value.trim()) || `noid-${simpleHash(summary + start.iso)}`;
  return {
    uid,
    summary,
    startUtc: start.iso,
    endUtc: endIso,
    location: unescapeText(raw.LOCATION && raw.LOCATION.value).trim(),
    description: unescapeText(raw.DESCRIPTION && raw.DESCRIPTION.value).trim(),
    status,
  };
}

export function parseIcal(text) {
  const lines = unfold(String(text)).split(/\r?\n/);
  const calendar = {};
  const rawEvents = [];
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) rawEvents.push(cur); cur = null; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(';');
    const params = {};
    for (const part of paramParts) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    const key = name.toUpperCase();
    if (cur) cur[key] = { value, params };
    else calendar[key] = { value, params };
  }
  return {
    calendarName: calendar['X-WR-CALNAME'] ? unescapeText(calendar['X-WR-CALNAME'].value).trim() : '',
    events: rawEvents.map(toEvent).filter(Boolean),
  };
}
