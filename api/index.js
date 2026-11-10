import { waitUntil } from '@vercel/functions';
import { handleRequest } from '../src/app.js';
import { makeEnv } from '../src/db.js';

// Een functie voor alle adressen; vercel.json stuurt alles hiernaartoe.
export default {
  async fetch(request) {
    let env;
    try {
      env = await makeEnv();
    } catch (err) {
      console.error('Database niet bereikbaar', err);
      return Response.json({ error: 'De database is niet bereikbaar. Controleer TURSO_DATABASE_URL en TURSO_AUTH_TOKEN.' }, { status: 500 });
    }
    return handleRequest(request, env, { waitUntil });
  },
};
