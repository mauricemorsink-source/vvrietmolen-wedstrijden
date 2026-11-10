# Rietmolen wedstrijden (Vercel)

Haalt de iCal-links van voetbal.nl op, houdt bij wat er verandert (verplaatst, afgelast,
nieuw, verdwenen) en levert een live feed voor de clubwebsite.

- `/admin` : beheerpagina (links plakken, teams, logo's, wijzigingen, codes voor de website)
- `/api/matches` : JSON voor de website, met logo's en status (`?team=ID`, `?upcoming=1`, `?limit=20`)
- `/feed.ics` : agenda-abonnement (`?team=ID` voor een los team)
- `/embed.js` : kant-en-klaar wedstrijdblok voor op de website

## Wat je nodig hebt

- Node.js (LTS) en Visual Studio Code
- Een gratis account bij **Turso** (de database) en bij **Vercel** (hosting)
- Een GitHub-account (het makkelijkst om naar Vercel te publiceren)

## 1. Lokaal proberen in Visual Studio Code

1. Pak de zip uit en kies in VS Code: Bestand, Map openen.
2. Open de terminal (Ctrl+`) en voer uit: `npm install`
3. Kopieer `.env.example` naar `.env` en vul `ADMIN_PASSWORD` in. De database-regels mag je leeg laten,
   dan gebruikt hij lokaal een SQLite-bestand (`local.db`).
4. `npm run dev` en ga naar http://localhost:3000/admin (gebruikersnaam mag alles zijn).

## 2. Database maken (Turso)

1. Maak een account op turso.tech en kies **Create database** (naam bijvoorbeeld `rietmolen`).
2. Open de database en kopieer de **URL** (begint met `libsql://`).
3. Kies **Generate token** en kopieer het token.

De tabellen worden bij de eerste aanroep vanzelf aangemaakt.

## 3. Publiceren op Vercel

1. In VS Code: tabblad Source Control, **Publish to GitHub** (privé mag).
2. Op vercel.com: **Add New, Project**, kies je repository.
   Framework Preset: **Other**. Laat de rest staan.
3. Zet onder **Environment Variables**:
   - `ADMIN_PASSWORD` : een lang wachtwoord voor `/admin`
   - `TURSO_DATABASE_URL` : de URL uit stap 2
   - `TURSO_AUTH_TOKEN` : het token uit stap 2
   - `CRON_SECRET` : een lange willekeurige tekst (alleen nodig voor de optionele GitHub-taak)
4. **Deploy**. Je krijgt een adres als `https://rietmolen-wedstrijden.vercel.app`.
5. Ga naar `/admin`, log in en plak je voetbal.nl-links.

Liever vanuit de terminal? `npx vercel` (eerste keer, koppelt het project) en `npx vercel --prod`.

## Hoe blijft het actueel?

Vercel (gratis plan) staat ingebouwde taken alleen **een keer per dag** toe. Daarom werkt het zo:

1. **Zelfverversend.** Vraagt iemand `/api/matches` of `/feed.ics` op en is een team ouder dan
   15 minuten, dan wordt het op de achtergrond opnieuw opgehaald. Een agenda-abonnement of de
   website zorgt er dus vanzelf voor.
2. **Optioneel: GitHub-taak.** `.github/workflows/sync.yml` haalt elke 15 minuten alles op, ook als
   niemand kijkt. Zet in GitHub onder Settings, Secrets and variables, Actions de secrets
   `SITE_URL` (je Vercel-adres) en `CRON_SECRET` (zelfde als in Vercel).
   GitHub kan een taak enkele minuten uitstellen, en schakelt geplande taken uit in
   repositories waar 60 dagen niets in gebeurt.
3. **Betaald Vercel-plan (Pro).** Dan kun je een echte taak toevoegen aan `vercel.json`:
   `"crons": [{ "path": "/api/cron/sync", "schedule": "*/15 * * * *" }]`.
   Zet dit **niet** op het gratis plan, dan mislukt de uitrol.

Op de beheerpagina kun je altijd handmatig synchroniseren.

## Op de website zetten

In `/admin`, tabblad Website, staan de codes om te kopieren. Bijvoorbeeld:

```html
<script src="https://JOUW-ADRES/embed.js" data-team="1" data-limit="10"></script>
```

## Hoe wijzigingen herkend worden

Een wedstrijd wordt eerst op het UID uit de feed gekoppeld. Geeft voetbal.nl bij een verplaatsing
een nieuw UID, dan wordt de wedstrijd daarna op dezelfde partij (thuis en uit) gekoppeld.
Wedstrijden die uit de feed verdwijnen krijgen status "verdwenen" en gaan uit de publieke feed.
Gespeelde wedstrijden blijven bewaard. Een volledig lege feed wordt gezien als storing en
verwijdert niets. Een wedstrijd die in beide teamfeeds staat (Rietmolen 4-Rietmolen 5) komt in de
gezamenlijke feed maar een keer voor.

## Goed om te weten

- Voeg per team maar een link toe. Twee links van hetzelfde team geven dubbele teams.
- Alleen links van `data.sportlink.com` worden geaccepteerd (`ALLOWED_HOSTS`).
- De links bevatten een geheim token. Dat staat alleen in de database en wordt in `/admin` afgekort getoond.
- Gratis Turso is ruim voldoende voor een club (500 miljoen gelezen en 10 miljoen geschreven regels per maand).

## Testen

`npm test` draait de controles op de logica (iCal lezen, tijdzones, verplaatst/afgelast/verdwenen).
