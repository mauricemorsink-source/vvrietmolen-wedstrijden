// Logica om wedstrijden uit de feed te koppelen aan wat we al opgeslagen hebben.

export function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Sleutel van een club: naam zonder teamnummer ("Hoeve Vooruit 3" wordt "hoeve vooruit").
// Ook dames- en meisjesteams ("Reutum VR1") delen het logo met hun club.
const TEAM_SUFFIX = /\s+(?:VR|ZA|ZO)?\d+$/i;

export function clubKey(teamName) {
  return norm(String(teamName).replace(TEAM_SUFFIX, ''));
}

export function clubDisplay(teamName) {
  return String(teamName).replace(TEAM_SUFFIX, '').trim();
}

// Leidt de eigen teamnaam af uit de wedstrijden zelf. Dat is nodig als de teamnaam in de
// wedstrijden afwijkt van de agendanaam en zelf een koppelteken bevat, zoals
// "ST Rietmolen- Lochuizen VR1". Het eigen team komt in (bijna) elke wedstrijd voor, dus we
// nemen de tekst die het vaakst als een van de twee kanten voorkomt.
export function inferOwnTeam(summaries, hint) {
  if (summaries.length < 2) return hint;
  const counts = new Map();
  for (const s of summaries) {
    const sides = new Set();
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '-') continue;
      sides.add(s.slice(0, i).trim());
      sides.add(s.slice(i + 1).trim());
    }
    for (const side of sides) if (side) counts.set(side, (counts.get(side) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [side, count] of counts) {
    const better = count > bestCount ||
      (count === bestCount && (norm(side) === norm(hint) || (norm(best) !== norm(hint) && side.length > best.length)));
    if (better) { best = side; bestCount = count; }
  }
  return bestCount >= Math.max(2, Math.ceil(summaries.length / 2)) ? best : hint;
}

// "Rietmolen 5-ST: SVBV-Klein Dochteren 3" met eigen team "Rietmolen 5" geeft
// thuis "Rietmolen 5" en uit "ST: SVBV-Klein Dochteren 3". Een koppelteken in een
// clubnaam wordt dus goed afgehandeld door de eigen teamnaam als anker te gebruiken.
export function splitTeams(summary, ownTeam) {
  const s = String(summary || '');
  const positions = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '-') positions.push(i);
  if (positions.length === 0) return { home: s.trim(), away: '' };
  const own = norm(ownTeam);
  let fallback = null;
  for (const pos of positions) {
    const left = s.slice(0, pos).trim();
    const right = s.slice(pos + 1).trim();
    if (!fallback) fallback = { home: left, away: right };
    if (own && (norm(left) === own || norm(right) === own)) return { home: left, away: right };
  }
  // Geen match met eigen team: neem het koppelteken dat het dichtst bij het midden zit.
  let best = positions[0];
  for (const pos of positions) if (Math.abs(pos - s.length / 2) < Math.abs(best - s.length / 2)) best = pos;
  return { home: s.slice(0, best).trim(), away: s.slice(best + 1).trim() };
}

const TRACKED = [
  ['summary', 'summary', 'summary'],
  ['start_utc', 'startUtc', 'start'],
  ['end_utc', 'endUtc', 'end'],
  ['location', 'location', 'location'],
  ['description', 'description', 'description'],
  ['status', 'status', 'status'],
];

/**
 * existing: rijen uit de matches-tabel van dit team (ook verwijderde).
 * incoming: events uit de feed (zie ical.js).
 * Geeft terug wat er moet gebeuren; schrijft zelf niets.
 */
export function diffMatches(existing, incoming, nowIso) {
  const warnings = [];
  const byUid = new Map(existing.map((r) => [r.uid, r]));
  const usedRows = new Set();
  const pairs = [];
  let leftoverIncoming = [];

  for (const ev of incoming) {
    const row = byUid.get(ev.uid);
    if (row && !usedRows.has(row.id)) {
      usedRows.add(row.id);
      pairs.push({ row, ev, uidChanged: false });
    } else {
      leftoverIncoming.push(ev);
    }
  }

  // Tweede ronde: andere UID maar dezelfde partij, dan gaat het om dezelfde wedstrijd
  // die verplaatst of opnieuw aangemaakt is. Kies de dichtstbijzijnde datum.
  const stillNew = [];
  for (const ev of leftoverIncoming) {
    let best = null;
    let bestDiff = Infinity;
    for (const row of existing) {
      if (usedRows.has(row.id)) continue;
      if (norm(row.summary) !== norm(ev.summary)) continue;
      const diff = Math.abs(Date.parse(row.start_utc) - Date.parse(ev.startUtc));
      if (diff < bestDiff) { best = row; bestDiff = diff; }
    }
    if (best) {
      usedRows.add(best.id);
      pairs.push({ row: best, ev, uidChanged: true });
    } else {
      stillNew.push(ev);
    }
  }

  const updates = [];
  let unchanged = 0;
  for (const { row, ev, uidChanged } of pairs) {
    const fields = {};
    const changes = [];
    for (const [col, key, label] of TRACKED) {
      if ((row[col] || '') !== (ev[key] || '')) {
        fields[col] = ev[key] || '';
        changes.push({
          kind: col === 'start_utc' ? 'reschedule' : col === 'status' ? (ev.status === 'cancelled' ? 'cancelled' : 'restored') : 'change',
          field: label,
          old: row[col] || '',
          new: ev[key] || '',
        });
      }
    }
    if (uidChanged) fields.uid = ev.uid;
    if (row.removed_at) {
      fields.removed_at = null;
      changes.push({ kind: 'restored', field: 'removed', old: row.removed_at, new: '' });
    }
    if (Object.keys(fields).length === 0) { unchanged++; continue; }
    updates.push({ id: row.id, label: ev.summary, fields, changes });
  }

  // Wedstrijden die uit de feed verdwenen zijn. Alleen toekomstige: gespeelde wedstrijden
  // laten we staan, ook als Sportlink ze laat vallen.
  const removals = [];
  const missing = existing.filter((r) => !usedRows.has(r.id) && !r.removed_at && r.start_utc > nowIso);
  const activeFuture = existing.filter((r) => !r.removed_at && r.start_utc > nowIso);
  if (incoming.length === 0 && activeFuture.length > 0) {
    warnings.push('De feed bevat geen wedstrijden. Er is niets verwijderd (mogelijk een tijdelijke storing).');
  } else {
    for (const r of missing) {
      removals.push({
        id: r.id,
        label: r.summary,
        changes: [{ kind: 'removed', field: 'feed', old: r.start_utc, new: '' }],
      });
    }
  }

  return { inserts: stillNew, updates, removals, unchanged, warnings };
}
