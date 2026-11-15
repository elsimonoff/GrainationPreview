// Optional helper: saves the list of Wikimedia Commons categories named
// "Photographs taken on <film>" to data/commons-categories.json.
// With this list, the website can match films to photo collections without
// first asking Commons to search, which makes film pages load a bit faster.
//
// It refreshes at most once a day and never fails the GitHub Action: if
// Commons is busy, the old list (or no list) is kept and the site falls back
// to searching from the visitor's browser.
//
// Wikimedia asks automated tools to identify themselves. Set the repository
// variable COMMONS_CONTACT (Settings → Secrets and variables → Actions →
// Variables) to a URL or email where they can reach you, if you want.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'commons-categories.json');
const MAX_AGE_HOURS = 24;
const contact = process.env.COMMONS_CONTACT ? ` (${process.env.COMMONS_CONTACT})` : '';
const UA = `ShelfLife-film-browser/1.0${contact}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min((Number(res.headers.get('retry-after')) || 5 * 2 ** attempt) * 1000, 90000);
      console.warn(`Commons answered ${res.status}; waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Commons answered ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.info);
    return json;
  }
  throw new Error('Commons stayed busy');
}

async function main() {
  try {
    const old = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
    const ageHours = (Date.now() - new Date(old.generatedAt).getTime()) / 3600e3;
    if (ageHours < MAX_AGE_HOURS && !process.env.FORCE) {
      console.log(`Category list is ${ageHours.toFixed(1)}h old; keeping it.`);
      return;
    }
  } catch {}

  const categories = [];
  let cont = {};
  for (;;) {
    const d = await api({ action: 'query', list: 'allpages', apnamespace: '14', apprefix: 'Photographs taken on', aplimit: '500', ...cont });
    categories.push(...d.query.allpages.map((p) => p.title));
    if (!d.continue) break;
    cont = d.continue;
    await sleep(1500);
  }
  // Commons also files photos by date ("Photographs taken on 2019-05-04") and
  // weekday. Keep only names that could be films, so the file stays small.
  const SKIP = /^Category:Photographs taken on (\d|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$|New Year)/;
  const films = categories.filter((c) => !SKIP.test(c));
  if (films.length < 20) throw new Error(`Only ${films.length} film categories found; not saving.`);
  await fs.writeFile(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), categories: films }, null, 1) + '\n');
  console.log(`Saved ${films.length} Commons film categories (of ${categories.length}).`);
}

main().catch((err) => {
  console.warn(`Skipped Commons category refresh: ${err.message}`);
});
