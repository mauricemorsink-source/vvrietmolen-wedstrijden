import assert from 'node:assert/strict';
import { parseIcal, formatLocal } from '../src/ical.js';
import { diffMatches, splitTeams, clubKey, clubDisplay, inferOwnTeam } from '../src/sync.js';

const ics = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Voetbal.nl - Rietmolen 5\r\n${events.join('')}END:VCALENDAR\r\n`;
const ev = (uid, summary, start, end, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART;TZID=Europe/Amsterdam:${start}\r\nDTEND;TZID=Europe/Amsterdam:${end}\r\nLOCATION:Sportpark De Wieken\\, Rietmolen\r\n${extra}END:VEVENT\r\n`;

// Parser: lokale tijd in winter (UTC+1) en zomer (UTC+2)
const a = parseIcal(ics([
  ev('1', 'Rietmolen 5-Vorden 6', '20261115T103000', '20261115T123000'),
  ev('2', 'Bentelo 8-Rietmolen 5', '20270404T090000', '20270404T110000'),
]));
assert.equal(a.calendarName, 'Voetbal.nl - Rietmolen 5');
assert.equal(a.events[0].startUtc, '2026-11-15T09:30:00Z');
assert.equal(a.events[1].startUtc, '2027-04-04T07:00:00Z'); // zomertijd
assert.equal(a.events[0].location, 'Sportpark De Wieken, Rietmolen');
assert.equal(formatLocal(a.events[1].startUtc), '2027-04-04T09:00');

// UTC-notatie en gevouwen regels
const b = parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:A-B\r\n C\r\nDTSTART:20261115T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
assert.equal(b.events[0].startUtc, '2026-11-15T09:30:00Z');
assert.equal(b.events[0].summary, 'A-BC');

// Teams splitsen met koppelteken in clubnaam
assert.deepEqual(splitTeams('Rietmolen 5-ST: SVBV-Klein Dochteren 3', 'Rietmolen 5'), { home: 'Rietmolen 5', away: 'ST: SVBV-Klein Dochteren 3' });
assert.deepEqual(splitTeams('Rietmolen 4-Rietmolen 5', 'Rietmolen 5'), { home: 'Rietmolen 4', away: 'Rietmolen 5' });
assert.equal(clubKey('Hoeve Vooruit 3'), 'hoeve vooruit');
assert.equal(clubKey('Reutum VR1'), 'reutum');
assert.equal(clubDisplay("TVC '28 VR2"), "TVC '28");

// Samenwerkingsteam met koppelteken in de eigen naam (Rietmolen VR1)
const vr1 = [
  'Reutum VR1-ST Rietmolen- Lochuizen VR1', 'ST Rietmolen- Lochuizen VR1-SVO Twickel VR1',
  'ST: Erix/KSV VR1-ST Rietmolen- Lochuizen VR1', 'ST Rietmolen- Lochuizen VR1-Sc. Overwetering VR1',
  'ST Rietmolen- Lochuizen VR1-TVC \'28 VR2', 'VIOS B. VR1-ST Rietmolen- Lochuizen VR1',
  'ST Rietmolen- Lochuizen VR1-Reutum VR1', 'SVO Twickel VR1-ST Rietmolen- Lochuizen VR1',
];
const own = inferOwnTeam(vr1, 'Rietmolen VR1');
assert.equal(own, 'ST Rietmolen- Lochuizen VR1');
assert.deepEqual(splitTeams(vr1[0], own), { home: 'Reutum VR1', away: 'ST Rietmolen- Lochuizen VR1' });
assert.deepEqual(splitTeams(vr1[1], own), { home: 'ST Rietmolen- Lochuizen VR1', away: 'SVO Twickel VR1' });
assert.equal(inferOwnTeam(['Rietmolen 5-Vorden 6', 'Hoeve Vooruit 3-Rietmolen 5', 'Rietmolen 5-ST: SVBV-Klein Dochteren 3'], 'Rietmolen 5'), 'Rietmolen 5');
assert.equal(inferOwnTeam(['A-B'], 'X'), 'X');

// Matching
const now = '2026-11-10T11:00:00Z';
const row = (id, uid, summary, start, extra = {}) => ({
  id, uid, summary, start_utc: start, end_utc: start, location: 'L', description: '', status: 'active', removed_at: null, ...extra,
});
const incoming = (uid, summary, start, extra = {}) => ({
  uid, summary, startUtc: start, endUtc: start, location: 'L', description: '', status: 'active', ...extra,
});

// ongewijzigd
let d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z')], [incoming('u1', 'A-B', '2026-11-15T09:30:00Z')], now);
assert.equal(d.unchanged, 1); assert.equal(d.updates.length, 0);

// verplaatst met dezelfde UID
d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z')], [incoming('u1', 'A-B', '2026-11-22T09:30:00Z')], now);
assert.equal(d.updates[0].changes[0].kind, 'reschedule');
assert.equal(d.inserts.length, 0);

// verplaatst waarbij Sportlink een nieuwe UID geeft: moet dezelfde wedstrijd blijven
d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z')], [incoming('u9', 'A-B', '2026-11-22T09:30:00Z')], now);
assert.equal(d.inserts.length, 0); assert.equal(d.removals.length, 0);
assert.equal(d.updates[0].id, 1); assert.equal(d.updates[0].fields.uid, 'u9');

// nieuwe wedstrijd, verdwenen toekomstige wedstrijd, gespeelde wedstrijd blijft
d = diffMatches(
  [row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z'), row(2, 'u2', 'C-D', '2026-10-01T09:30:00Z')],
  [incoming('u3', 'E-F', '2026-12-01T09:30:00Z')], now);
assert.equal(d.inserts.length, 1);
assert.deepEqual(d.removals.map((r) => r.id), [1]);

// lege feed verwijdert niets
d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z')], [], now);
assert.equal(d.removals.length, 0); assert.equal(d.warnings.length, 1);

// afgelast en weer hersteld
d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z')], [incoming('u1', 'A-B', '2026-11-15T09:30:00Z', { status: 'cancelled' })], now);
assert.equal(d.updates[0].changes[0].kind, 'cancelled');
d = diffMatches([row(1, 'u1', 'A-B', '2026-11-15T09:30:00Z', { removed_at: '2026-11-01T00:00:00Z' })], [incoming('u1', 'A-B', '2026-11-15T09:30:00Z')], now);
assert.equal(d.updates[0].fields.removed_at, null);

// Ontdubbelen (onderlinge wedstrijd in twee feeds) en iCal-regels vouwen op bytes
const { dedupe, fold } = await import('../src/app.js');
assert.equal(dedupe([{ summary: 'A-B', start_utc: 'x' }, { summary: 'a-b', start_utc: 'x' }, { summary: 'A-B', start_utc: 'y' }]).length, 2);
assert.equal(fold('kort'), 'kort');
const long = 'A'.repeat(200);
const folded = fold(long).split('\r\n');
assert.equal(folded[0].length, 75);
assert.ok(folded.slice(1).every((l) => l.startsWith(' ') && l.length <= 75));
assert.equal(folded.map((l, i) => (i ? l.slice(1) : l)).join(''), long);
const accents = 'é'.repeat(60); // 2 bytes per teken
for (const l of fold(accents).split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75);

console.log('Alle tests geslaagd');
