// Loads sample photos for a film from Wikimedia Commons, straight from the
// visitor's browser. Commons allows this ("origin=*"), needs no key, and every
// photo there is freely licensed, so we can show it with credit to the author.

import { bestCategory, searchPhrase, searchWords, CATEGORY_PREFIX } from './match.js';

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

const LENS_HINT = /\b\d+(\.\d+)?\s?mm\b|f\/?\s?\d|\blens\b|nikkor|summicron|summilux|summarit|summaron|elmarit|elmar|noctilux|zuiko|takumar|planar|sonnar|tessar|biogon|distagon|helios|industar|jupiter|rokkor|hexanon|ultron|nokton|skopar|heliar|xenon|xenar|sigma|tamron|tokina|canon fd|canon ef/i;

function describeCategories(cats) {
  const cameras = [];
  const lenses = [];
  let format = null;
  const films = [];
  for (const { title } of cats) {
    if (title.startsWith(CATEGORY_PREFIX)) films.push(title.slice(CATEGORY_PREFIX.length));
    let m = title.match(/^Category:Taken with (.+)$/);
    if (m) {
      const name = m[1].replace(/\s*\((?:camera|lens)\)$/i, '');
      (LENS_HINT.test(name) && !/camera/i.test(name) ? lenses : cameras).push(name);
      continue;
    }
    m = title.match(/^Category:Taken on (.+ film)$/i);
    if (m) format = m[1];
  }
  return { cameras, lenses, format, films };
}

function exifValue(metadata, name) {
  const v = (metadata || []).find((m) => m.name === name)?.value;
  return typeof v === 'string' ? v.trim() : null;
}

function toPhoto(page) {
  const info = page.imageinfo?.[0];
  if (!info || !info.thumburl) return null;
  if (!/^image\/(jpeg|png|webp|tiff|gif)/.test(info.mime || 'image/jpeg')) return null;
  const meta = info.extmetadata || {};
  const { cameras, lenses, format, films } = describeCategories(page.categories || []);
  const make = exifValue(info.metadata, 'Make');
  const model = exifValue(info.metadata, 'Model');
  let device = [make, model].filter(Boolean).join(' ');
  if (make && model && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0])) device = model;
  const title = page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
  return {
    title,
    pageUrl: info.descriptionurl,
    thumb: info.thumburl,
    width: info.thumbwidth,
    height: info.thumbheight,
    full: info.url,
    cameras,
    lenses,
    format, // e.g. "35mm film", "120 film"
    films, // Commons film collections it's filed under, e.g. ["Kodak Tri-X 400"]
    device: device || null, // what the file's metadata says made it (often the scanner)
    date: TEXT(meta.DateTimeOriginal?.value || '').slice(0, 10) || null,
    author: TEXT(meta.Artist?.value || '') || 'Unknown author',
    license: TEXT(meta.LicenseShortName?.value || ''),
    licenseUrl: meta.LicenseUrl?.value || null,
    description: TEXT(meta.ImageDescription?.value || '').slice(0, 280),
  };
}

const PHOTO_PROPS = {
  prop: 'imageinfo|categories',
  cllimit: 'max',
  iiprop: 'url|extmetadata|metadata|mime',
  iiurlwidth: '800',
  iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|DateTimeOriginal|ImageDescription',
};

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
