import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL('./' + name, import.meta.url), 'utf8');

export const ADMIN_HTML = read('admin.html');
export const EMBED_JS = read('embed.js.txt');
