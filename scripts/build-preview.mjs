// Builds a self-contained snapshot of the site in a folder, for hosts that
// don't let a page load anything from other websites (such as a private
// claude.ai page). Product images and sample photos are downloaded and
// stored next to the page; the page runs in "static mode" (no live calls).
//
//   node scripts/build-preview.mjs <output-folder>
//
// The snapshot shows stock as of data/films.json and the photos in data/photos.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || 'preview');
const PHOTOS_PER_FILM = 9;
const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'img'), { recursive: true });
await fs.mkdir(path.join(OUT, 'assets'), { recursive: true });
await fs.mkdir(path.join(OUT, 'data'), { recursive: true });

// Downloads an image once and returns its local path ("img/<hash>.<ext>"), or null.
const done = new Map();
async function local(url, fallbacks = []) {
  if (!url) return null;
  if (done.has(url)) return done.get(url);
  for (const u of [url, ...fallbacks]) {
    try {
      let res = await fetch(u);
      // Image servers rate-limit bursts: wait and retry a few times.
      for (let attempt = 1; res.status === 429 && attempt <= 4; attempt++) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        res = await fetch(u);
      }
      if (!res.ok) continue;
      const type = res.headers.get('content-type') || '';
      const ext = type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : 'jpg';
      const name = `img/${crypto.createHash('sha1').update(u).digest('hex').slice(0, 16)}.${ext}`;
      await fs.writeFile(path.join(OUT, name), Buffer.from(await res.arrayBuffer()));
      done.set(url, name);
      return name;
    } catch {}
  }
  done.set(url, null);
  return null;
}
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Films: shop images at 300 px.
const films = JSON.parse(await read('data/films.json'));
await inBatches(films.films, 6, async (f) => {
  if (!f.image) return;
  const medium = f.image.src.replace(/(\.\w+)$/, '-300x300$1');
  const file = await local(medium, [f.image.thumb, f.image.src]);
  f.image = file ? { ...f.image, src: file, thumb: file } : null;
});

// Photos: Commons thumbnails at 500 px.
let photos = { films: {} };
try {
  photos = JSON.parse(await read('data/photos.json'));
} catch {
  console.warn('No data/photos.json yet: the snapshot will have no sample photos.');
}
const inStock = new Set(films.films.map((f) => f.name));
for (const name of Object.keys(photos.films)) if (!inStock.has(name)) delete photos.films[name];
const jobs = [];
for (const entry of Object.values(photos.films)) {
  entry.photos = (entry.photos || []).slice(0, PHOTOS_PER_FILM);
  for (const p of entry.photos) jobs.push(p);
}
await inBatches(jobs, 3, async (p) => {
  const smaller = p.thumb.replace(/\/\d+px-/, '/500px-');
  const file = await local(smaller, [p.thumb]);
  p.thumb = file;
  p.big = file;
});
for (const entry of Object.values(photos.films)) entry.photos = entry.photos.filter((p) => p.thumb);

await fs.writeFile(path.join(OUT, 'data/films.json'), JSON.stringify(films));
await fs.writeFile(path.join(OUT, 'data/photos.json'), JSON.stringify(photos));
for (const f of ['data/settings.json', 'data/commons-overrides.json']) await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
for (const f of ['app.js', 'commons.js', 'match.js', 'flickr.js', 'photo-parse.js', 'styles.css']) await fs.copyFile(path.join(ROOT, 'assets', f), path.join(OUT, 'assets', f));

// The page: same markup as index.html, minus the document wrapper (the host adds it),
// plus the static-mode switch and a note saying when the snapshot was taken.
const html = await read('index.html');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
let body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const keepHead = head
  .split('\n')
  .filter((l) => /<title>|fonts\.g|stylesheet|rel="icon"/.test(l))
  .join('\n');
const when = new Date(films.updatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' });
body = body
  .replace('href="#/"', 'href="#films"')
  .replace('<script type="module" src="assets/app.js"></script>', '<script>window.SHELF_LIFE_STATIC = true;</script>\n    <script type="module" src="assets/app.js"></script>')
  .replace(
    /<footer class="site-footer">\s*<div class="wrap">/,
    `<footer class="site-footer">\n      <div class="wrap">\n        <p><strong>Snapshot:</strong> stock as of ${when} (Toronto time). The live site refreshes hourly.</p>`,
  );
await fs.writeFile(path.join(OUT, 'index.html'), `${keepHead}\n${body}`);

const count = Object.values(photos.films).reduce((n, e) => n + e.photos.length, 0);
console.log(`Snapshot in ${OUT}: ${films.films.length} films, ${count} photos, ${done.size} images.`);
