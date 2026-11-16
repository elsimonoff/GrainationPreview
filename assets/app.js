// Shelf Life: the page logic.
// Two views, switched by the address bar "hash":
//   #/                → list of in-stock films
//   #/film/<slug>     → one film, with sample photos and cameras

import { findSource, loadPhotos, categoryUrl, cameraCategoryUrl, prettyCategory, preferredPool, preferredPhotosFor, preferredRank, shotOnFilm, savedPhotos, savedPool, settings } from './commons.js';

// Static mode: a snapshot copy of the site that can't call other websites
// (set by the preview build). Only the saved photos are shown there.
const STATIC = Boolean(window.SHELF_LIFE_STATIC);

// Links between views. The snapshot copy uses simple "#film-<slug>" links,
// which is all claude.ai pages allow; the full site uses "#/film/<slug>".
const HOME_HREF = STATIC ? '#films' : '#/';
const filmHref = (slug) => (STATIC ? `#film-${encodeURIComponent(slug)}` : `#/film/${encodeURIComponent(slug)}`);

const main = document.getElementById('main');
const lightbox = document.getElementById('lightbox');

const state = {
  data: null,
  filters: loadFilters(),
  pref: null, // { names, byFilm: Map(slug → { count, camera }) } once loaded
};

// ---------- helpers ----------

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (n, currency = 'CAD') =>
  n == null ? '' : new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(n);

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'just now';
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (s >= size) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.round(s / size), unit);
  }
  return 'just now';
}

function filmKind(film) {
  const t = (film.type || '').toLowerCase();
  if (t.includes('slide')) return 'slide';
  if (t.includes('black')) return 'bw';
  if (t.includes('color') || t.includes('colour')) return 'color';
  return 'other';
}
const KIND_LABEL = { color: 'Color negative', bw: 'Black & white', slide: 'Slide', other: 'Other' };

function isoNumber(film) {
  const n = parseInt(String(film.iso || '').match(/\d+/)?.[0], 10);
  return Number.isFinite(n) ? n : null;
}
const ISO_BUCKETS = [
  { id: 'slow', label: 'ISO ≤ 100', test: (n) => n <= 100 },
  { id: 'mid', label: '125–250', test: (n) => n > 100 && n <= 250 },
  { id: 'fast', label: '320–500', test: (n) => n > 250 && n <= 500 },
  { id: 'xfast', label: '800+', test: (n) => n > 500 },
];

function packLabel(film) {
  const parts = [];
  if (film.rolls > 1) parts.push(`${film.rolls} rolls`);
  if (film.exposures) parts.push(`${film.exposures} exp`);
  return parts.join(' · ');
}

function priceHtml(film) {
  const sale = film.onSale && film.regularPrice > film.price;
  return `<span class="price">${sale ? `<s>${esc(money(film.regularPrice, film.currency))}</s>` : ''}${esc(money(film.price, film.currency))}</span>`;
}

const CAMERA_ICON = `<svg class="cam-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>`;

function loadFilters() {
  try {
    return { q: '', kind: 'all', iso: 'all', sort: 'name', pref: false, ...JSON.parse(sessionStorage.getItem('filters') || '{}') };
  } catch {
    return { q: '', kind: 'all', iso: 'all', sort: 'name', pref: false };
  }
}
function saveFilters() {
  try {
    sessionStorage.setItem('filters', JSON.stringify(state.filters));
  } catch {}
}

// ---------- data ----------

async function loadData() {
  if (state.data) return state.data;
  const res = await fetch(`data/films.json?t=${Math.floor(Date.now() / 300000)}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load the film list (${res.status}).`);
  state.data = await res.json();
  await Promise.all([loadLomography(), loadRedditPosts()]);
  return state.data;
}

// Each film's own page on Lomography (data/lomography-films.json, editable by hand).
async function loadLomography() {
  if (state.lomography) return state.lomography;
  try {
    const res = await fetch('data/lomography-films.json', { cache: 'no-cache' });
    state.lomography = res.ok ? await res.json() : {};
  } catch {
    state.lomography = {};
  }
  return state.lomography;
}

// Hand-picked r/analog posts per film (data/reddit-posts.json), shown with Reddit's official embed.
async function loadRedditPosts() {
  if (state.reddit) return state.reddit;
  try {
    const res = await fetch('data/reddit-posts.json', { cache: 'no-cache' });
    state.reddit = res.ok ? await res.json() : {};
  } catch {
    state.reddit = {};
  }
  return state.reddit;
}

const REDDIT_POST = /^https:\/\/(www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+(\/[^\s?#]*)?/i;

function redditPostsFor(film) {
  const list = state.reddit?.[film.name];
  if (!Array.isArray(list)) return [];
  return list
    .map((u) => String(u).trim().match(REDDIT_POST)?.[0].replace('://old.', '://www.').replace('://reddit.com', '://www.reddit.com'))
    .filter(Boolean);
}

function renderReddit(film) {
  const box = main.querySelector('#reddit');
  const posts = redditPostsFor(film);
  // The snapshot copy can't load Reddit's script, so leave the section out there.
  if (!box || STATIC || posts.length === 0) return;
  const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  box.hidden = false;
  box.querySelector('.reddit-posts').innerHTML = posts
    .map(
      (url) => `<div class="reddit-post"><blockquote class="reddit-embed-bq" data-embed-theme="${dark ? 'dark' : 'light'}" data-embed-showmedia="true" data-embed-showtitle="true" data-embed-height="560"><a href="${esc(url)}">View this post on r/analog</a></blockquote></div>`,
    )
    .join('');
  // Reddit's script turns each blockquote into the live post. It only scans the
  // page when it loads, so add a fresh copy every time a film page opens.
  document.getElementById('reddit-widgets')?.remove();
  const script = document.createElement('script');
  script.id = 'reddit-widgets';
  script.async = true;
  script.src = 'https://embed.reddit.com/widgets.js';
  script.charset = 'UTF-8';
  document.body.appendChild(script);
}

function elsewhereLinks(film) {
  const q = encodeURIComponent(film.name.replace(/\b(professional|eastman)\b/gi, '').replace(/\s+/g, ' ').trim());
  const lomo = state.lomography?.[film.name];
  const lomoLink =
    typeof lomo === 'string' && lomo.startsWith('https://www.lomography.com/')
      ? `<a class="btn secondary" href="${esc(lomo)}" target="_blank" rel="noopener">Lomography ↗</a>`
      : '';
  return `
    ${lomoLink}
    <a class="btn secondary" href="https://www.flickr.com/search/?text=${q}" target="_blank" rel="noopener">Flickr ↗</a>
    <a class="btn secondary" href="https://www.reddit.com/r/analog/search/?q=${q}&restrict_sr=1" target="_blank" rel="noopener">r/analog ↗</a>
    ${lomoLink ? '' : '<span class="pack">Not in Lomography’s film library yet.</span>'}`;
}

// ---------- list view ----------

function renderList() {
  const { films, updatedAt } = state.data;
  document.title = 'Shelf Life · 35mm film in stock';

  main.innerHTML = `
    <section class="hero">
      <h1>${films.length} films in 35mm,<br><em>in stock</em> right now.</h1>
      <p>Every 35mm film on the shelf at Graination. Open one to see real photos shot on it, and the cameras that took them.</p>
      <p class="status" title="${esc(new Date(updatedAt).toLocaleString())}">Stock list last changed ${esc(timeAgo(updatedAt))} · checked hourly</p>
    </section>

    <section class="toolbar" aria-label="Filter films">
      <div class="toolbar-row">
        <label class="visually-hidden" for="q">Search films</label>
        <input id="q" class="search" type="search" placeholder="Search: Portra, HP5, Kodak…" value="${esc(state.filters.q)}" autocomplete="off" />
        <label class="visually-hidden" for="sort">Sort</label>
        <select id="sort" class="sort">
          <option value="name">Sort: Name</option>
          <option value="price">Sort: Price, low to high</option>
          <option value="price-desc">Sort: Price, high to low</option>
          <option value="iso">Sort: ISO, slow to fast</option>
          <option value="pref">Sort: My camera’s photos first</option>
        </select>
      </div>
      <div class="toolbar-row" role="group" aria-label="Film type">
        <span class="toolbar-label">Type</span>
        ${['all', 'color', 'bw', 'slide']
          .map((k) => {
            const n = k === 'all' ? films.length : films.filter((f) => filmKind(f) === k).length;
            if (k !== 'all' && n === 0) return '';
            return `<button class="chip" data-kind="${k}" aria-pressed="${state.filters.kind === k}">${k === 'all' ? 'All' : KIND_LABEL[k]}<span class="count">${n}</span></button>`;
          })
          .join('')}
      </div>
      <div class="toolbar-row" role="group" aria-label="Film speed">
        <span class="toolbar-label">Speed</span>
        <button class="chip" data-iso="all" aria-pressed="${state.filters.iso === 'all'}">Any ISO</button>
        ${ISO_BUCKETS.map((b) => `<button class="chip" data-iso="${b.id}" aria-pressed="${state.filters.iso === b.id}">${b.label}</button>`).join('')}
      </div>
      <div class="toolbar-row" id="pref-row" role="group" aria-label="My camera" hidden></div>
    </section>

    <p class="result-count" id="count" aria-live="polite"></p>
    <ul class="grid" id="grid"></ul>
  `;

  const sort = main.querySelector('#sort');
  sort.value = state.filters.sort;
  main.querySelector('#q').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    saveFilters();
    renderGrid();
  });
  sort.addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    saveFilters();
    renderGrid();
  });
  main.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filters.kind = b.dataset.kind;
      main.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      saveFilters();
      renderGrid();
    }),
  );
  main.querySelectorAll('[data-iso]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filters.iso = b.dataset.iso;
      main.querySelectorAll('[data-iso]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      saveFilters();
      renderGrid();
    }),
  );
  renderGrid();
  loadPreferredForList();
}

// Finds which films have photos from your camera (data/settings.json) and
// shows a ★ badge on them, plus a filter chip.
async function loadPreferredForList() {
  const row = main.querySelector('#pref-row');
  const drawRow = () => {
    if (!row || !row.isConnected) return;
    const { names, byFilm, failed } = state.pref || {};
    if (!names?.length && state.pref) return (row.hidden = true);
    row.hidden = false;
    const label = names?.[0] || 'your camera';
    if (!state.pref) {
      row.innerHTML = `<span class="toolbar-label">Camera</span><span class="pack">Looking for photos taken with your camera…</span>`;
      return;
    }
    const n = byFilm.size;
    row.innerHTML = `<span class="toolbar-label">Camera</span>${
      n
        ? `<button class="chip chip-pref" data-pref aria-pressed="${state.filters.pref}">★ Has ${esc(label)} photos<span class="count">${n}</span></button>`
        : `<span class="pack">${failed ? `Couldn’t check for ${esc(label)} photos right now.` : `No ${esc(label)} photos on Wikimedia Commons for these films yet.`}</span>`
    }`;
    row.querySelector('[data-pref]')?.addEventListener('click', (e) => {
      state.filters.pref = !state.filters.pref;
      e.currentTarget.setAttribute('aria-pressed', state.filters.pref);
      saveFilters();
      renderGrid();
    });
  };
  if (state.pref) return drawRow();
  drawRow();
  try {
    const { names, photos } = STATIC ? await savedPool() : await preferredPool();
    const byFilm = new Map();
    for (const f of state.data.films) {
      let count = 0;
      let best = Infinity;
      for (const p of photos) {
        if (!shotOnFilm(p, f.name)) continue;
        const r = preferredRank({ ...p, cameras: [...p.cameras] }, names);
        if (r < 0) continue;
        count++;
        best = Math.min(best, r);
      }
      if (count) byFilm.set(f.slug, { count, camera: names[best] });
    }
    state.pref = { names, byFilm };
  } catch {
    state.pref = { names: ['your camera'], byFilm: new Map(), failed: true };
  }
  drawRow();
  if (main.querySelector('#grid')) renderGrid();
}

function renderGrid() {
  const { q, kind, iso, sort } = state.filters;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const bucket = ISO_BUCKETS.find((b) => b.id === iso);
  let list = state.data.films.filter((f) => {
    if (kind !== 'all' && filmKind(f) !== kind) return false;
    if (state.filters.pref && state.pref && !state.pref.byFilm.has(f.slug)) return false;
    if (bucket) {
      const n = isoNumber(f);
      if (n == null || !bucket.test(n)) return false;
    }
    const hay = `${f.fullName} ${f.brand} ${f.type} ${f.iso}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name) || a.price - b.price,
    price: (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    iso: (a, b) => (isoNumber(a) ?? 1e9) - (isoNumber(b) ?? 1e9) || a.name.localeCompare(b.name),
    pref: (a, b) => (state.pref?.byFilm.get(b.slug)?.count || 0) - (state.pref?.byFilm.get(a.slug)?.count || 0) || a.name.localeCompare(b.name),
  };
  list = list.slice().sort(by[sort] || by.name);

  main.querySelector('#count').textContent = list.length === state.data.films.length ? `Showing all ${list.length} films` : `Showing ${list.length} of ${state.data.films.length} films`;
  const grid = main.querySelector('#grid');
  if (list.length === 0) {
    grid.innerHTML = `<li class="empty" style="grid-column:1/-1">No films match those filters.</li>`;
    return;
  }
  grid.innerHTML = list
    .map((f) => {
      const k = filmKind(f);
      const pref = state.pref?.byFilm.get(f.slug);
      return `<li>
        <a class="card" href="${filmHref(f.slug)}">
          <div class="card-img">${f.image ? `<img src="${esc(f.image.src)}" alt="" loading="lazy" decoding="async" />` : ''}</div>
          <div class="card-body">
            <span class="brand">${esc(f.brand || '')}</span>
            <h2 class="card-title">${esc(f.name)}</h2>
            <div class="card-meta">
              ${f.iso ? `<span class="tag iso">ISO ${esc(f.iso)}</span>` : ''}
              <span class="tag type-${k}">${esc(f.type || KIND_LABEL[k])}</span>
              ${f.onSale ? '<span class="tag sale">Sale</span>' : ''}
              ${pref ? `<span class="tag pref" title="${pref.count} photo${pref.count > 1 ? 's' : ''} taken with ${esc(pref.camera)}">★ ${esc(pref.camera)} · ${pref.count}</span>` : ''}
            </div>
            <div class="card-foot">
              ${priceHtml(f)}
              <span class="pack">${esc(packLabel(f))}</span>
            </div>
          </div>
        </a>
      </li>`;
    })
    .join('');
}

// ---------- film view ----------

let filmRenderId = 0;

function renderFilm(slug) {
  const film = state.data.films.find((f) => f.slug === slug);
  if (!film) {
    main.innerHTML = `
      <a class="back" href="${HOME_HREF}">← All films</a>
      <div class="error-box"><h1>That film isn’t in stock any more</h1><p>It may have sold out since you opened this link. <a href="${HOME_HREF}">See what’s in stock now.</a></p></div>`;
    return;
  }
  document.title = `${film.name} · Shelf Life`;
  const k = filmKind(film);
  const siblings = state.data.films.filter((f) => f.name === film.name && f.slug !== film.slug);

  main.innerHTML = `
    <a class="back" href="${HOME_HREF}">← All films</a>
    <section class="film-hero">
      <div class="film-img">${film.image ? `<img src="${esc(film.image.src)}" alt="${esc(film.image.alt)}" />` : ''}</div>
      <div class="film-info">
        <span class="brand">${esc(film.brand || '')}</span>
        <h1>${esc(film.name)}</h1>
        <div class="buy-row">
          ${priceHtml(film)}
          <span class="in-stock">● ${esc(film.lowStock ? `Only ${film.lowStock} left` : film.stockText)}</span>
          <a class="btn" href="${esc(film.url)}" target="_blank" rel="noopener">Buy at Graination ↗</a>
        </div>
        <dl class="specs">
          ${spec('ISO', film.iso)}
          ${spec('Type', film.type || KIND_LABEL[k])}
          ${spec('Format', film.format || '35mm')}
          ${spec('Exposures', film.exposures)}
          ${spec('Pack', film.rolls > 1 ? `${film.rolls} rolls` : '1 roll')}
          ${spec('Process', film.process)}
        </dl>
        ${siblings.length ? `<p class="summary">Also in stock: ${siblings.map((s) => `<a href="${filmHref(s.slug)}">${esc(packLabel(s) || s.fullName)} for ${esc(money(s.price, s.currency))}</a>`).join(', ')}</p>` : ''}
        ${film.summary ? `<p class="summary">${esc(film.summary)}</p>` : ''}
        ${film.descriptionHtml ? `<details class="more"><summary>Full description from Graination</summary><div class="desc">${film.descriptionHtml}</div></details>` : ''}
      </div>
    </section>

    <section aria-labelledby="samples-title">
      <div class="samples-head">
        <h2 id="samples-title">Shot on ${esc(film.name)}</h2>
      </div>
      <p class="pref-note" id="pref-note" hidden></p>
      <p class="source-note" id="source-note">Looking for sample photos on Wikimedia Commons…</p>
      <div class="cameras" id="cameras"></div>
      <div class="gallery" id="gallery"></div>
      <div class="gallery-foot" id="gallery-foot"></div>
      <section class="reddit" id="reddit" aria-labelledby="reddit-title" hidden>
        <h3 id="reddit-title">From r/analog</h3>
        <p class="source-note">Posts picked by hand. On r/analog the title usually names the camera and film.</p>
        <div class="reddit-posts"></div>
      </section>
      <div class="elsewhere">
        <span class="toolbar-label">More photos of this film</span>
        <div class="link-row" id="elsewhere">${elsewhereLinks(film)}</div>
      </div>
    </section>
  `;
  window.scrollTo({ top: 0 });
  loadSamples(film, ++filmRenderId);
  renderReddit(film);
}

function spec(label, value) {
  if (value == null || value === '') return '';
  return `<div class="spec"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

async function loadSamples(film, renderId) {
  const note = main.querySelector('#source-note');
  const gallery = main.querySelector('#gallery');
  const foot = main.querySelector('#gallery-foot');
  const camerasEl = main.querySelector('#cameras');
  const prefNoteEl = main.querySelector('#pref-note');
  const samples = { photos: [], preferred: [], names: [], next: null, camera: null, only35: false };
  const stale = () => renderId !== filmRenderId;

  let source;
  let sourceError = null;
  // Photos the GitHub Action already collected open instantly.
  const kept = await savedPhotos(film.name);
  if (stale()) return;
  if (kept) {
    source = kept.source;
    samples.photos = kept.photos.slice();
    samples.fromSaved = true;
    samples.canLoadLive = !STATIC;
  } else if (STATIC) {
    return showNothing();
  } else {
    try {
      source = await findSource(film.name);
    } catch (err) {
      sourceError = err; // Commons trouble: your camera's photos (e.g. from Flickr) can still show
    }
    if (stale()) return;
    if (!source && !sourceError) return showNothing(); // turned off in commons-overrides.json
  }

  // Your camera's photos of this film go first.
  try {
    if (STATIC) {
      samples.names = ((await settings()).preferredCameras || []).filter(Boolean);
    } else {
      const pref = await preferredPhotosFor(film.name, source || null);
      samples.preferred = pref.photos;
      samples.names = pref.names;
    }
  } catch {
    // Not fatal: just show the regular photos.
  }
  if (stale()) return;
  if (sourceError) {
    if (samples.preferred.length === 0) return showError(sourceError);
    note.textContent = `Other sample photos couldn’t load right now (${sourceError.message}).`;
    return draw();
  }

  const describe = () =>
    source.kind === 'category'
      ? `Freely licensed photos from the Wikimedia Commons collection <a href="${esc(categoryUrl(source.title))}" target="_blank" rel="noopener">“Photographs taken on ${esc(prettyCategory(source.title))}”</a>, newest first. Tap a photo for camera details and credits.`
      : `There’s no dedicated collection for this film on Wikimedia Commons, so these are photos whose descriptions mention <strong>${esc(source.query.replace(/"/g, ''))}</strong>. Check each photo’s details to confirm the film.`;

  async function more() {
    foot.innerHTML = `<button class="btn secondary" disabled>Loading…</button>`;
    samples.canLoadLive = false;
    try {
      const page = await loadPhotos(source, samples.next);
      if (stale()) return;
      const have = new Set(samples.photos.map((p) => p.pageUrl));
      samples.photos.push(...page.photos.filter((p) => !have.has(p.pageUrl)));
      samples.next = page.next;
      samples.pages = (samples.pages || 0) + 1;
      // Strict filtering can empty a page of text-search results; look a bit further.
      if (page.photos.length === 0 && page.next && samples.pages < 4) return more();
    } catch (err) {
      if (stale()) return;
      if (samples.preferred.length === 0 && samples.photos.length === 0) return showError(err);
      draw();
      foot.innerHTML = `<p class="pack">Couldn’t load more photos: ${esc(err.message)}</p>`;
      return;
    }
    // Nothing in the category: fall back to a text search once.
    if (samples.photos.length === 0 && source.kind === 'category' && !samples.triedSearch) {
      samples.triedSearch = true;
      source = { kind: 'search', query: `"${film.name}"` };
      samples.next = null;
      samples.pages = 0;
      return more();
    }
    if (samples.photos.length === 0 && samples.preferred.length === 0) return showNothing();
    note.innerHTML = samples.photos.length ? describe() : '';
    draw();
  }

  // Your camera's photos first, then everything else (no duplicates).
  function combined() {
    const names = samples.names;
    const seen = new Set();
    const out = [];
    for (const p of [...samples.preferred, ...samples.photos]) {
      if (seen.has(p.pageUrl)) continue;
      seen.add(p.pageUrl);
      const q = { ...p, cameras: [...p.cameras] };
      q.rank = names.length ? preferredRank(q, names) : -1;
      out.push(q);
    }
    const order = (p) => (p.rank < 0 ? Infinity : p.rank);
    return out.map((p, i) => [p, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([p]) => p);
  }

  function visible(all) {
    return all.filter((p) => (!samples.camera || p.cameras.includes(samples.camera)) && (!samples.only35 || p.format === '35mm film'));
  }

  function drawPrefNote(all) {
    const names = samples.names;
    if (!names.length) return (prefNoteEl.hidden = true);
    const mine = all.filter((p) => p.rank === 0).length;
    const sisters = all.filter((p) => p.rank > 0).length;
    prefNoteEl.hidden = false;
    prefNoteEl.classList.toggle('found', mine + sisters > 0);
    if (mine + sisters === 0) {
      prefNoteEl.innerHTML = `No photos taken with your ${esc(names[0])} on this film are on Wikimedia Commons yet, so you’re seeing other cameras.`;
      return;
    }
    const parts = [];
    if (mine) parts.push(`${mine} taken with your <strong>${esc(names[0])}</strong>`);
    if (sisters) {
      const models = [...new Set(all.filter((p) => p.rank > 0).map((p) => names[p.rank]))];
      parts.push(`${sisters} with the sister model${models.length > 1 ? 's' : ''} ${esc(models.join(' and '))} (same lens)`);
    }
    const fromFlickr = all.some((p) => p.rank >= 0 && p.site === 'Flickr');
    prefNoteEl.innerHTML = `★ ${parts.join(' and ')}, shown first.${fromFlickr ? ' Flickr photos belong to their photographers; tap one for credit and a link to the original.' : ''}`;
  }

  function draw() {
    // Camera summary chips
    const all = combined();
    drawPrefNote(all);
    const counts = new Map();
    for (const p of all) for (const c of p.cameras) counts.set(c, (counts.get(c) || 0) + 1);
    const unknown = all.filter((p) => p.cameras.length === 0).length;
    const formats = new Set(all.map((p) => p.format).filter(Boolean));
    const camRank = (c) => {
      const i = samples.names.findIndex((n) => n.toLowerCase() === c.toLowerCase());
      return i < 0 ? Infinity : i;
    };
    const sorted = [...counts].sort((a, b) => camRank(a[0]) - camRank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
    camerasEl.innerHTML = sorted.length
      ? `<span class="toolbar-label">Cameras</span>
         <button class="chip" data-cam="" aria-pressed="${!samples.camera}">All<span class="count">${all.length}</span></button>
         ${sorted.map(([c, n]) => `<button class="chip ${camRank(c) < Infinity ? 'chip-pref' : ''}" data-cam="${esc(c)}" aria-pressed="${samples.camera === c}">${camRank(c) < Infinity ? '★ ' : ''}${esc(c)}<span class="count">${n}</span></button>`).join('')}
         ${unknown ? `<span class="pack">${unknown} with camera not listed</span>` : ''}
         ${formats.size > 1 || (formats.size === 1 && !formats.has('35mm film')) ? `<button class="chip" data-only35 aria-pressed="${samples.only35}">35mm shots only</button>` : ''}`
      : '';
    camerasEl.querySelectorAll('[data-cam]').forEach((b) =>
      b.addEventListener('click', () => {
        samples.camera = b.dataset.cam || null;
        draw();
      }),
    );
    camerasEl.querySelector('[data-only35]')?.addEventListener('click', () => {
      samples.only35 = !samples.only35;
      draw();
    });

    const list = visible(all);
    gallery.innerHTML = list.length
      ? list
          .map((p, i) => {
            const cam = p.cameras[0];
            return `<button class="shot ${p.rank >= 0 ? 'preferred' : ''}" data-i="${i}" aria-label="Open photo: ${esc(p.title)}">
              <img src="${esc(p.thumb)}" width="${p.width}" height="${p.height}" alt="${esc(p.description || p.title)}" loading="lazy" decoding="async" />
              <span class="shot-cap">
                <span class="shot-cam ${cam ? '' : 'unknown'}">${p.rank >= 0 ? '<span class="star" aria-hidden="true">★</span>' : CAMERA_ICON}<span>${esc(cam || 'Camera not listed')}</span></span>
                ${p.format && p.format !== '35mm film' ? `<span class="tag">${esc(p.format.replace(' film', ''))}</span>` : ''}
              </span>
            </button>`;
          })
          .join('')
      : `<p class="no-photos">No photos match this filter yet${samples.next ? ' – try loading more.' : '.'}</p>`;
    gallery.querySelectorAll('.shot').forEach((b) => b.addEventListener('click', () => openLightbox(list, Number(b.dataset.i), film, samples.names)));

    const moreUrl = source?.kind === 'category' ? categoryUrl(source.title) : `https://commons.wikimedia.org/w/index.php?ns6=1&search=${encodeURIComponent(source?.query || film.name)}`;
    foot.innerHTML =
      samples.next || samples.canLoadLive
        ? `<button class="btn secondary" id="more">Load more photos</button>`
        : STATIC && source
          ? `<a class="btn secondary" href="${esc(moreUrl)}" target="_blank" rel="noopener">More on Wikimedia Commons ↗</a>`
          : '';
    foot.querySelector('#more')?.addEventListener('click', more);
  }

  function showNothing() {
    note.innerHTML = '';
    gallery.innerHTML = `<div class="no-photos">
      <p>No freely licensed sample photos of <strong>${esc(film.name)}</strong> on Wikimedia Commons yet. The photo communities below have plenty, with the camera listed on most.</p>
    </div>`;
    foot.innerHTML = '';
  }

  function showError(err) {
    note.textContent = '';
    gallery.innerHTML = `<div class="no-photos"><p>Couldn’t load sample photos: ${esc(err.message)}</p><button class="btn secondary" id="retry">Try again</button></div>`;
    gallery.querySelector('#retry').addEventListener('click', () => loadSamples(film, ++filmRenderId));
    foot.innerHTML = '';
  }

  if (samples.fromSaved) {
    note.innerHTML = describe();
    draw();
  } else {
    more();
  }
}

// ---------- lightbox ----------

function openLightbox(list, index, film, names = []) {
  const p = list[index];
  const cam = p.cameras;
  lightbox.innerHTML = `
    <div class="lb-inner">
      <div class="lb-img"><img src="${esc(p.big || p.thumb.replace(/\/\d+px-/, '/1600px-'))}" alt="${esc(p.description || p.title)}" /></div>
      <div class="lb-side">
        <button class="lb-close" aria-label="Close">×</button>
        <h3>${esc(p.title)}</h3>
        <dl class="facts">
          <div><dt>Camera</dt><dd>${p.rank === 0 ? '<span class="pref-badge">★ Your camera</span>' : p.rank > 0 ? `<span class="pref-badge">★ Sister model of your ${esc(names[0] || '')}</span>` : ''}${
            cam.length
              ? cam.map((c) => `${esc(c)}<span class="hint"><a href="${esc(p.site === 'Flickr' ? `https://www.flickr.com/photos/tags/${encodeURIComponent(c.toLowerCase().replace(/[^a-z0-9]/g, ''))}` : cameraCategoryUrl(c))}" target="_blank" rel="noopener">More photos from this camera ↗</a> · <a href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(c + ' camera')}" target="_blank" rel="noopener">About it ↗</a></span>`).join('<br>')
              : 'Not listed by the photographer'
          }</dd></div>
          ${p.lenses.length ? `<div><dt>Lens</dt><dd>${p.lenses.map(esc).join('<br>')}</dd></div>` : ''}
          <div><dt>Film</dt><dd>${esc(p.films.length ? p.films.join(', ') : film.name)}${p.format ? `<span class="hint">Shot on ${esc(p.format)}</span>` : ''}</dd></div>
          ${p.device ? `<div><dt>File made with</dt><dd>${esc(p.device)}<span class="hint">From the file’s metadata. For film this is usually the scanner, not the camera.</span></dd></div>` : ''}
          ${p.date ? `<div><dt>Date</dt><dd>${esc(p.date)}</dd></div>` : ''}
          <div><dt>Photo by</dt><dd>${esc(p.author)}${p.license ? `<span class="hint">License: ${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}" target="_blank" rel="noopener">${esc(p.license)}</a>` : esc(p.license)}</span>` : ''}</dd></div>
        </dl>
        ${p.description ? `<p class="lb-desc">${esc(p.description)}</p>` : ''}
        <p class="lb-desc"><a href="${esc(p.pageUrl)}" target="_blank" rel="noopener">View on ${esc(p.site || 'Wikimedia Commons')} ↗</a></p>
        <div class="lb-nav">
          <button class="btn secondary" data-step="-1" ${index === 0 ? 'disabled' : ''}>← Previous</button>
          <button class="btn secondary" data-step="1" ${index === list.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    </div>`;
  const big = lightbox.querySelector('.lb-img img');
  big.addEventListener('error', () => (big.src = p.thumb), { once: true });
  lightbox.querySelector('.lb-close').addEventListener('click', () => lightbox.close());
  lightbox.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => openLightbox(list, index + Number(b.dataset.step), film, names)));
  lightbox.onkeydown = (e) => {
    if (e.key === 'ArrowRight' && index < list.length - 1) openLightbox(list, index + 1, film, names);
    if (e.key === 'ArrowLeft' && index > 0) openLightbox(list, index - 1, film, names);
  };
  if (!lightbox.open) lightbox.showModal();
}
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) lightbox.close();
});

// ---------- routing ----------

async function route() {
  if (lightbox.open) lightbox.close();
  try {
    await loadData();
  } catch (err) {
    main.innerHTML = `<div class="error-box"><h1>Couldn’t load the film list</h1><p>${esc(err.message)}</p></div>`;
    return;
  }
  const m = location.hash.match(/^#(?:\/film\/|film-)([^/?#]+)/);
  if (m) renderFilm(decodeURIComponent(m[1]));
  else renderList();
}

window.addEventListener('hashchange', route);
route();
