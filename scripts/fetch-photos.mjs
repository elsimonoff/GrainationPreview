// Collects sample photos for every in-stock film from Wikimedia Commons and
// saves them to data/photos.json, so film pages open instantly and visitors'
// browsers don't each have to ask Commons.
//
// Run by the GitHub Action after fetch-stock.mjs. Each film is refreshed at
// most once a week; the script is polite (one request every 1.5 s, backs off
// when Commons asks) and never fails the Action: whatever it finished is saved.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestCategory, searchPhrase } from '../assets/match.js';
import { parsePhoto, PHOTO_PROPS } from '../assets/photo-parse.js';
import { decodeEntities } from './fetch-stock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILMS = path.join(ROOT, 'data', 'films.json');
const CATEGORIES = path.join(ROOT, 'data', 'commons-categories.json');
const OVERRIDES = path.join(ROOT, 'data', 'commons-overrides.json');
const OUT_FILE = path.join(ROOT, 'data', 'photos.json');
const PER_FILM = 12;
const MAX_AGE_DAYS = 7;
const contact = process.env.COMMONS_CONTACT ? ` (${process.env.COMMONS_CONTACT})` : '';
const UA = `ShelfLife-film-browser/1.0${contact}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const TEXT = (html = '') =>
  decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

let lastCall = 0;
async function api(params) {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + 1500 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min((Number(res.headers.get('retry-after')) || 5 * 2 ** attempt) * 1000, 90000);
      console.warn(`Commons answered ${res.status}; waiting ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) throw new Error(`Commons answered ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.info);
    return json;
  }
  throw new Error('Commons stayed busy');
}

async function details(titles) {
  if (titles.length === 0) return [];
  const res = await api({ action: 'query', titles: titles.join('|'), ...PHOTO_PROPS });
  const byTitle = new Map((res.query?.pages || []).map((p) => [p.title, p]));
  return titles
    .map((t) => byTitle.get(t))
    .filter(Boolean)
    .map((p) => parsePhoto(p, TEXT))
    .filter(Boolean);
}

async function photosFor(name, categories, overrides) {
  let source;
  const manual = overrides[name];
  if (manual === null || manual === false) return { source: null, photos: [] };
  if (typeof manual === 'string') source = manual.startsWith('Category:') ? { kind: 'category', title: manual } : { kind: 'search', query: manual };
  else {
    const title = bestCategory(name, categories);
    source = title ? { kind: 'category', title } : { kind: 'search', query: `"${searchPhrase(name)}"` };
  }

  if (source.kind === 'category') {
    const res = await api({ action: 'query', list: 'categorymembers', cmtitle: source.title, cmtype: 'file', cmlimit: String(PER_FILM), cmsort: 'timestamp', cmdir: 'desc' });
    const photos = await details((res.query?.categorymembers || []).map((m) => m.title));
    if (photos.length) return { source, photos };
    source = { kind: 'search', query: `"${searchPhrase(name)}"` };
  }
  const res = await api({ action: 'query', list: 'search', srnamespace: '6', srlimit: '30', srsearch: `${source.query} filetype:bitmap` });
  const found = await details((res.query?.search || []).map((m) => m.title));
  // Text search also finds photos of film boxes and adverts: keep only photos filed as shot on film.
  return { source, photos: found.filter((p) => p.films.length > 0 || p.format).slice(0, PER_FILM) };
}

async function main() {
  const { films = [] } = await readJson(FILMS, {});
  const categories = (await readJson(CATEGORIES, {})).categories || [];
  const overrides = await readJson(OVERRIDES, {});
  const old = (await readJson(OUT_FILE, {})).films || {};
  const names = [...new Set(films.map((f) => f.name))];
  const out = {};
  let fetched = 0;
  let failed = 0;
  for (const name of names) {
    const prev = old[name];
    const ageDays = prev ? (Date.now() - new Date(prev.fetchedAt).getTime()) / 864e5 : Infinity;
    if (prev && ageDays < MAX_AGE_DAYS && !process.env.FORCE) {
      out[name] = prev;
      continue;
    }
    try {
      const result = await photosFor(name, categories, overrides);
      out[name] = { fetchedAt: new Date().toISOString(), ...result };
      fetched++;
      console.log(`${name}: ${result.photos.length} photos (${result.source?.title || result.source?.query || 'off'})`);
    } catch (err) {
      failed++;
      console.warn(`${name}: skipped (${err.message})`);
      if (prev) out[name] = prev;
      if (failed >= 5) {
        console.warn('Commons keeps refusing; saving what we have and stopping.');
        for (const n of names) if (!out[n] && old[n]) out[n] = old[n];
        break;
      }
    }
  }
  if (fetched === 0 && Object.keys(out).length === Object.keys(old).length) {
    console.log('No photo changes.');
    return;
  }
  await fs.writeFile(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), films: out }, null, 1) + '\n');
  console.log(`Saved photos for ${Object.keys(out).length} films (${fetched} refreshed).`);
}

main().catch((err) => console.warn(`Skipped photo refresh: ${err.message}`));
