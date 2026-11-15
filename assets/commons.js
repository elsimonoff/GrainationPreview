// Loads sample photos for a film from Wikimedia Commons, straight from the
// visitor's browser. Commons allows this ("origin=*"), needs no key, and every
// photo there is freely licensed, so we can show it with credit to the author.

import { bestCategory, searchPhrase, searchWords, tokens, BRANDS, CATEGORY_PREFIX } from './match.js';
import { searchCameraPhotos, squash as squashTag } from './flickr.js';
import { parsePhoto, PHOTO_PROPS } from './photo-parse.js';

const API = 'https://commons.wikimedia.org/w/api.php';
const CACHE_HOURS = 12;
const PAGE_SIZE = 20;

// ---------- network + cache ----------

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Wikimedia Commons answered ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.info || 'Wikimedia Commons error');
    return json;
  }
  throw new Error('Wikimedia Commons is busy right now. Try again in a minute.');
}

function cacheGet(key) {
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.t < CACHE_HOURS * 3600e3) return hit.v;
  } catch {}
  return undefined;
}
function cacheSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {}
}
async function cached(key, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value);
  return value;
}

// ---------- finding where a film's photos live ----------

let overridesPromise;
function loadJson(path) {
  return fetch(path, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
function overrides() {
  overridesPromise ??= loadJson('data/commons-overrides.json').then((o) => o || {});
  return overridesPromise;
}
let catalogPromise;
function catalog() {
  catalogPromise ??= loadJson('data/commons-categories.json').then((c) => c?.categories || null);
  return catalogPromise;
}

// Returns { kind: 'category', title } or { kind: 'search', query } or null.
export async function findSource(filmName) {
  const manual = (await overrides())[filmName];
  if (manual === null || manual === false) return null;
  if (typeof manual === 'string') {
    return manual.startsWith('Category:') ? { kind: 'category', title: manual } : { kind: 'search', query: manual };
  }

  const list = await catalog();
  let title = list ? bestCategory(filmName, list) : null;
  if (!list) {
    // No pre-built list of categories: ask Commons for likely ones, from the
    // most specific word ("Tri-X", "Delta") down to just the brand.
    title = await cached(`commons:v2:cat:${filmName}`, async () => {
      for (const words of searchWords(filmName)) {
        const res = await api({ action: 'query', list: 'search', srnamespace: '14', srlimit: '100', srsearch: `intitle:"Photographs taken on" ${words}` });
        const found = bestCategory(filmName, (res.query?.search || []).map((s) => s.title));
        if (found) return found;
      }
      return null;
    });
  }
  if (title) return { kind: 'category', title };
  return { kind: 'search', query: `"${searchPhrase(filmName)}"` };
}

// ---------- reading photo details ----------

const TEXT = (html = '') => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
};

const toPhoto = (page) => parsePhoto(page, TEXT);

// Loads one page of photos. Pass the `next` value from a previous call to get more.
// Step 1 lists file names, step 2 fetches their details (picture, camera, credit).
export async function loadPhotos(source, next = null) {
  const key = `commons:v1:photos:${source.kind}:${source.title || source.query}:${next ? JSON.stringify(next) : ''}`;
  return cached(key, async () => {
    let titles;
    let cont = null;
    if (source.kind === 'category') {
      const res = await api({ action: 'query', list: 'categorymembers', cmtitle: source.title, cmtype: 'file', cmlimit: String(PAGE_SIZE), cmsort: 'timestamp', cmdir: 'desc', ...(next || {}) });
      titles = (res.query?.categorymembers || []).map((m) => m.title);
      if (res.continue?.cmcontinue) cont = { cmcontinue: res.continue.cmcontinue };
    } else {
      const res = await api({ action: 'query', list: 'search', srnamespace: '6', srlimit: String(PAGE_SIZE), srsearch: `${source.query} filetype:bitmap`, ...(next || {}) });
      titles = (res.query?.search || []).map((m) => m.title);
      if (res.continue?.sroffset) cont = { sroffset: String(res.continue.sroffset) };
    }
    if (titles.length === 0) return { photos: [], next: null };
    const res = await api({ action: 'query', titles: titles.join('|'), ...PHOTO_PROPS });
    const byTitle = new Map((res.query?.pages || []).map((p) => [p.title, p]));
    // Titles can come back normalised; fall back to matching by position.
    const pages = titles.map((t, i) => byTitle.get(t) || res.query?.pages?.[i]).filter(Boolean);
    let photos = pages.map(toPhoto).filter(Boolean);
    // A text search also finds photos *of* film boxes, adverts, etc. Keep only
    // photos that Commons files as having been shot on film.
    if (source.kind === 'search') photos = photos.filter((p) => p.films.length > 0 || p.format);
    return { photos, next: cont, scanned: titles.length };
  });
}

export function categoryUrl(title) {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/g, ':')}`;
}
export function cameraCategoryUrl(camera) {
  return categoryUrl(`Category:Taken with ${camera}`);
}
export function prettyCategory(title) {
  return title.replace(CATEGORY_PREFIX, '');
}

// ---------- preferred camera (e.g. your Ricoh R1s) ----------
// Photos taken with the cameras in data/settings.json → "preferredCameras"
// are collected once (from each camera's "Taken with …" collection on Commons),
// matched to films, and shown first with a star.

let settingsPromise;
export function settings() {
  settingsPromise ??= loadJson('data/settings.json').then((s) => ({ preferredCameras: [], flickrApiKey: '', flickrCreativeCommonsOnly: false, ...(s || {}) }));
  return settingsPromise;
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Ricoh R1" must not match "Ricoh R1s", so the name must end at a non-letter.
const nameRx = (name) => new RegExp(`(^|[^a-z0-9])${name.trim().split(/\s+/).map(escapeRx).join('[\\s-]*')}(?![a-z0-9])`, 'i');

// Index of the preferred camera this photo was taken with (0 = main camera), or -1.
// Uses the photographer's "Taken with" tag, or the camera named in the title/description.
export function preferredRank(photo, names) {
  let best = -1;
  names.forEach((name, i) => {
    if (best !== -1 && best <= i) return;
    const hitTag = photo.cameras.some((c) => squash(c) === squash(name));
    const hitText = !hitTag && nameRx(name).test(`${photo.title} ${photo.description}`);
    if (hitTag || hitText) {
      best = i;
      if (hitText && !photo.cameras.some((c) => squash(c) === squash(name))) photo.cameras.unshift(name);
    }
  });
  return best;
}

const ISO_STEPS = ['25', '50', '64', '80', '100', '125', '160', '200', '250', '320', '400', '500', '640', '800', '1600', '3200', '6400'];

// Was this photo shot on this film? Checks the photo's "Photographs taken on …"
// tags first, then its title and description.
export function shotOnFilm(photo, filmName, sourceTitle = null) {
  if (sourceTitle && photo.films.includes(sourceTitle.replace(CATEGORY_PREFIX, ''))) return true;
  if (photo.films.length) return Boolean(bestCategory(filmName, photo.films.map((f) => CATEGORY_PREFIX + f)));
  const text = new Set(tokens(`${photo.title} ${photo.description}`));
  // Flickr tags are squashed ("kodakgold200"): match words inside them, and
  // read a speed from the end of film-ish tags ("kodakgold100" → 100).
  const tags = (photo.tags || []).map(squashTag);
  for (const t of tags) {
    const m = t.match(/[a-z](\d{2,4})$/);
    if (m) text.add(m[1]);
  }
  const film = tokens(filmName);
  const words = film.filter((t) => !BRANDS.has(t) && !/^\d+$/.test(t));
  const iso = film.find((t) => /^\d+$/.test(t));
  const has = (w) => text.has(w) || tags.some((t) => t.includes(w));
  if (words.length === 0 || !words.every(has)) return false;
  // "Kodak Gold" in the text is fine for Gold 200, but "Kodak Gold 100" is not.
  if (iso && !text.has(iso) && ISO_STEPS.some((n) => n !== iso && text.has(n))) return false;
  return true;
}

// All photos on Commons taken with the preferred cameras (cached for 12 hours).
export async function preferredPool() {
  const names = ((await settings()).preferredCameras || []).filter(Boolean);
  if (names.length === 0) return { names, photos: [] };
  const { flickrApiKey, flickrCreativeCommonsOnly: ccOnly } = await settings();
  const fromCommons = cached(`commons:v1:pool:${names.join('|')}`, async () => {
    // Which "Taken with …" collections exist?
    const titles = names.map((n) => `Category:Taken with ${n}`);
    const info = await api({ action: 'query', titles: titles.join('|'), prop: 'categoryinfo' });
    const existing = (info.query?.pages || []).filter((p) => !p.missing && p.categoryinfo?.files > 0).map((p) => p.title);
    const files = [];
    for (const cat of existing) {
      const res = await api({ action: 'query', list: 'categorymembers', cmtitle: cat, cmtype: 'file', cmlimit: '200', cmsort: 'timestamp', cmdir: 'desc' });
      files.push(...(res.query?.categorymembers || []).map((m) => m.title));
    }
    // Plus photos whose description names the main camera but that aren't tagged with it.
    const named = await api({ action: 'query', list: 'search', srnamespace: '6', srlimit: '50', srsearch: `"${names[0]}" filetype:bitmap` });
    files.push(...(named.query?.search || []).map((m) => m.title));
    const unique = [...new Set(files)];
    const out = [];
    for (let i = 0; i < unique.length; i += 25) {
      const res = await api({ action: 'query', titles: unique.slice(i, i + 25).join('|'), ...PHOTO_PROPS });
      out.push(...(res.query?.pages || []).map(toPhoto).filter(Boolean));
    }
    return out;
  });
  const fromFlickr = flickrApiKey
    ? cached(`flickr:v1:pool:${names.join('|')}`, () => searchCameraPhotos(flickrApiKey, names, '', 500, ccOnly)).catch(() => [])
    : Promise.resolve([]);
  const [a, b] = await Promise.all([fromCommons.catch(() => []), fromFlickr]);
  return { names, photos: [...a, ...b] };
}

// Preferred-camera photos for one film: from the camera pool, plus photos whose
// description mentions both the camera and the film. Best camera first.
export async function preferredPhotosFor(filmName, source = null) {
  const { names, photos: pool } = await preferredPool();
  if (names.length === 0) return { names, photos: [] };
  const found = pool.filter((p) => shotOnFilm(p, filmName, source?.title));
  const extra = [];
  const { flickrApiKey, flickrCreativeCommonsOnly: ccOnly } = await settings();
  if (flickrApiKey) {
    const words = searchPhrase(filmName).split(/\s+/);
    // "Kodak Gold 200" → "Gold 200"; keep the brand when that's all there is ("FUJIFILM 200").
    const text = words.slice(1).some((w) => !/^\d+$/.test(w)) ? words.slice(1).join(' ') : words.join(' ');
    const more = await cached(`flickr:v1:film:${names.join('|')}:${filmName}`, () => searchCameraPhotos(flickrApiKey, names, text, 60, ccOnly)).catch(() => []);
    extra.push(...more);
  }
  const seen = new Set(found.map((p) => p.pageUrl));
  for (const p of extra) {
    if (!seen.has(p.pageUrl) && shotOnFilm(p, filmName, source?.title)) {
      seen.add(p.pageUrl);
      found.push(p);
    }
  }
  const ranked = found.map((p) => ({ ...p, cameras: [...p.cameras], rank: 0 }));
  for (const p of ranked) p.rank = preferredRank(p, names);
  return { names, photos: ranked.filter((p) => p.rank >= 0).sort((a, b) => a.rank - b.rank) };
}

// ---------- photos saved by the GitHub Action (data/photos.json) ----------

let savedPromise;
function saved() {
  savedPromise ??= loadJson('data/photos.json').then((d) => d?.films || {});
  return savedPromise;
}
// { source, photos } for one film, or null when nothing was saved for it.
export async function savedPhotos(filmName) {
  const entry = (await saved())[filmName];
  return entry && entry.photos?.length ? entry : null;
}
// Every saved photo, for spotting your camera's photos without asking Commons.
export async function savedPool() {
  const names = ((await settings()).preferredCameras || []).filter(Boolean);
  const all = Object.values(await saved()).flatMap((e) => e.photos || []);
  return { names, photos: all };
}
