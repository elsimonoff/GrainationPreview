// Fetches every 35mm film that is currently in stock at graination.ca
// and writes it to data/films.json for the website to read.
//
// Run it with:  node scripts/fetch-stock.mjs
// The GitHub Action in .github/workflows/update.yml runs it every hour.
//
// It uses the shop's public WooCommerce "Store API" (the same data the shop's
// own pages use). No login or key is needed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOP = 'https://graination.ca';
const CATEGORY_35MM = 29; // "35mm Film" category (slug: 35mm-film)
const PER_PAGE = 100;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'films.json');

// ---------- small text helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', times: '×', eacute: 'é' };

export function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function stripTags(html = '') {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Keeps only simple, safe formatting tags from the shop's description.
function simplifyHtml(html = '') {
  return html
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)(h[1-6])[^>]*>/gi, (_, slash) => `<${slash}h4>`)
    .replace(/<(\/?)(p|ul|ol|li|strong|em|b|i|br)(\s[^>]*)?>/gi, '<$1$2>')
    .replace(/<a\s[^>]*>|<\/a>/gi, '') // drop links (they point around the shop)
    .replace(/<(?!\/?(h4|p|ul|ol|li|strong|em|b|i|br)\b)[^>]+>/gi, '')
    .trim();
}

// "Kodak Gold 200 35mm Color Negative Film — 3 Rolls, 36 Exposures Each" -> "Kodak Gold 200"
export function filmName(productName) {
  let name = decodeEntities(productName);
  const cut = name.search(/\s+(?:35\s?mm\b|[—–]|-\s|\()/i);
  if (cut > 0) name = name.slice(0, cut);
  // "... 400 Color Negative Film" -> "... 400" (but keep "Lomography Color Negative 400")
  name = name.replace(/\s+(?:colou?r negative|colou?r slide|black\s*(?:&|and)\s*white|b\s*&\s*w)?\s*film\s*$/i, '');
  return name.trim();
}

function attr(product, label) {
  const a = product.attributes.find((x) => x.name.toLowerCase() === label.toLowerCase());
  return a ? a.terms.map((t) => decodeEntities(t.name)).join(', ') : null;
}

function money(prices, field) {
  const minor = Number(prices[field]);
  if (!Number.isFinite(minor)) return null;
  return minor / 10 ** prices.currency_minor_unit;
}

function exposures(name) {
  const m = decodeEntities(name).match(/(\d+)\s*exp/i);
  return m ? Number(m[1]) : null;
}

function rolls(name) {
  const m = decodeEntities(name).match(/(\d+)\s*(?:rolls|-pack|pack)/i);
  return m ? Number(m[1]) : 1;
}

// ---------- fetching ----------

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return { data: await res.json(), headers: res.headers };
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`Retrying (${attempt}) after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function fetchAll35mm() {
  const all = [];
  for (let page = 1; ; page++) {
    const url = `${SHOP}/wp-json/wc/store/v1/products?category=${CATEGORY_35MM}&per_page=${PER_PAGE}&page=${page}`;
    const { data, headers } = await getJson(url);
    all.push(...data);
    const totalPages = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || data.length === 0) break;
  }
  return all;
}

function toFilm(p) {
  const brand = (p.brands || []).map((b) => decodeEntities(b.name)).find((n) => n !== 'Brands') || null;
  const image = p.images?.[0];
  return {
    id: p.id,
    slug: p.slug,
    name: filmName(p.name),
    fullName: decodeEntities(p.name),
    brand,
    iso: attr(p, 'ISO') || (filmName(p.name).match(/\b(\d{2,4})\b/) || [])[1] || null,
    type: attr(p, 'Film Type') || (/colou?r negative/i.test(p.name) ? 'Color Negative' : /black|b\s*&\s*w/i.test(p.name) ? 'Black & White' : null),
    process: attr(p, 'Process'),
    format: attr(p, 'Format'),
    exposures: exposures(p.name),
    rolls: rolls(p.name),
    price: money(p.prices, 'price'),
    regularPrice: money(p.prices, 'regular_price'),
    onSale: p.on_sale,
    currency: p.prices.currency_code,
    lowStock: p.low_stock_remaining,
    stockText: p.stock_availability?.text || 'In stock',
    url: p.permalink,
    image: image ? { src: image.src, thumb: image.thumbnail, alt: decodeEntities(image.alt || p.name) } : null,
    summary: stripTags(p.short_description),
    descriptionHtml: simplifyHtml(decodeEntities(p.description)),
  };
}

async function main() {
  const products = await fetchAll35mm();
  const is35 = (p) => {
    const format = attr(p, 'Format');
    return !format || /35\s?mm/i.test(format);
  };
  const inStock = products.filter((p) => p.is_in_stock && is35(p)).map(toFilm);
  inStock.sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    source: `${SHOP}/product-category/film/35mm-film/`,
    totalIn35mmCategory: products.length,
    inStockCount: inStock.length,
    films: inStock,
  };

  // Only touch the file (and its timestamp) when the stock list actually changed,
  // so the hourly job doesn't create a commit every hour for nothing.
  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
  } catch {}
  const { updatedAt: _ignored, ...prevComparable } = previous || {};
  if (previous && JSON.stringify(prevComparable) === JSON.stringify(payload)) {
    console.log(`No change: ${inStock.length} films in stock.`);
    return;
  }
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), ...payload }, null, 2) + '\n');
  console.log(`Wrote ${inStock.length} in-stock films (of ${products.length} in the 35mm category).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
