// Shelf Life: the page logic.
// Two views, switched by the address bar "hash":
//   #/                → list of in-stock films
//   #/film/<slug>     → one film, with sample photos and cameras

import { findSource, loadPhotos, categoryUrl, cameraCategoryUrl, prettyCategory } from './commons.js';

const main = document.getElementById('main');
const lightbox = document.getElementById('lightbox');

const state = {
  data: null,
  filters: loadFilters(),
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
    return { q: '', kind: 'all', iso: 'all', sort: 'name', ...JSON.parse(sessionStorage.getItem('filters') || '{}') };
  } catch {
    return { q: '', kind: 'all', iso: 'all', sort: 'name' };
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
  return state.data;
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
}

function renderGrid() {
  const { q, kind, iso, sort } = state.filters;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const bucket = ISO_BUCKETS.find((b) => b.id === iso);
  let list = state.data.films.filter((f) => {
    if (kind !== 'all' && filmKind(f) !== kind) return false;
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
      return `<li>
        <a class="card" href="#/film/${esc(f.slug)}">
          <div class="card-img">${f.image ? `<img src="${esc(f.image.src)}" alt="" loading="lazy" decoding="async" />` : ''}</div>
          <div class="card-body">
            <span class="brand">${esc(f.brand || '')}</span>
            <h2 class="card-title">${esc(f.name)}</h2>
            <div class="card-meta">
              ${f.iso ? `<span class="tag iso">ISO ${esc(f.iso)}</span>` : ''}
              <span class="tag type-${k}">${esc(f.type || KIND_LABEL[k])}</span>
              ${f.onSale ? '<span class="tag sale">Sale</span>' : ''}
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
      <a class="back" href="#/">← All films</a>
      <div class="error-box"><h1>That film isn’t in stock any more</h1><p>It may have sold out since you opened this link. <a href="#/">See what’s in stock now.</a></p></div>`;
    return;
  }
  document.title = `${film.name} · Shelf Life`;
  const k = filmKind(film);
  const siblings = state.data.films.filter((f) => f.name === film.name && f.slug !== film.slug);

  main.innerHTML = `
    <a class="back" href="#/">← All films</a>
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
        ${siblings.length ? `<p class="summary">Also in stock: ${siblings.map((s) => `<a href="#/film/${esc(s.slug)}">${esc(packLabel(s) || s.fullName)} for ${esc(money(s.price, s.currency))}</a>`).join(', ')}</p>` : ''}
        ${film.summary ? `<p class="summary">${esc(film.summary)}</p>` : ''}
        ${film.descriptionHtml ? `<details class="more"><summary>Full description from Graination</summary><div class="desc">${film.descriptionHtml}</div></details>` : ''}
      </div>
    </section>

    <section aria-labelledby="samples-title">
      <div class="samples-head">
        <h2 id="samples-title">Shot on ${esc(film.name)}</h2>
      </div>
      <p class="source-note" id="source-note">Looking for sample photos on Wikimedia Commons…</p>
      <div class="cameras" id="cameras"></div>
      <div class="gallery" id="gallery"></div>
      <div class="gallery-foot" id="gallery-foot"></div>
    </section>
  `;
  window.scrollTo({ top: 0 });
  loadSamples(film, ++filmRenderId);
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
  const samples = { photos: [], next: null, camera: null, only35: false };
  const stale = () => renderId !== filmRenderId;

  let source;
  try {
    source = await findSource(film.name);
  } catch (err) {
    if (!stale()) showError(err);
    return;
  }
  if (stale()) return;
  if (!source) return showNothing();

  const describe = () =>
    source.kind === 'category'
      ? `Freely licensed photos from the Wikimedia Commons collection <a href="${esc(categoryUrl(source.title))}" target="_blank" rel="noopener">“Photographs taken on ${esc(prettyCategory(source.title))}”</a>, newest first. Tap a photo for camera details and credits.`
      : `There’s no dedicated collection for this film on Wikimedia Commons, so these are photos whose descriptions mention <strong>${esc(source.query.replace(/"/g, ''))}</strong>. Check each photo’s details to confirm the film.`;

  async function more() {
    foot.innerHTML = `<button class="btn secondary" disabled>Loading…</button>`;
    try {
      const page = await loadPhotos(source, samples.next);
      if (stale()) return;
      samples.photos.push(...page.photos);
      samples.next = page.next;
      samples.pages = (samples.pages || 0) + 1;
      // Strict filtering can empty a page of text-search results; look a bit further.
      if (page.photos.length === 0 && page.next && samples.pages < 4) return more();
    } catch (err) {
      if (!stale()) showError(err);
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
    if (samples.photos.length === 0) return showNothing();
    note.innerHTML = describe();
    draw();
  }

  function visible() {
    return samples.photos.filter((p) => (!samples.camera || p.cameras.includes(samples.camera)) && (!samples.only35 || p.format === '35mm film'));
  }

  function draw() {
    // Camera summary chips
    const counts = new Map();
    for (const p of samples.photos) for (const c of p.cameras) counts.set(c, (counts.get(c) || 0) + 1);
    const unknown = samples.photos.filter((p) => p.cameras.length === 0).length;
    const formats = new Set(samples.photos.map((p) => p.format).filter(Boolean));
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    camerasEl.innerHTML = sorted.length
      ? `<span class="toolbar-label">Cameras</span>
         <button class="chip" data-cam="" aria-pressed="${!samples.camera}">All<span class="count">${samples.photos.length}</span></button>
         ${sorted.map(([c, n]) => `<button class="chip" data-cam="${esc(c)}" aria-pressed="${samples.camera === c}">${esc(c)}<span class="count">${n}</span></button>`).join('')}
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

    const list = visible();
    gallery.innerHTML = list.length
      ? list
          .map((p, i) => {
            const cam = p.cameras[0];
            return `<button class="shot" data-i="${i}" aria-label="Open photo: ${esc(p.title)}">
              <img src="${esc(p.thumb)}" width="${p.width}" height="${p.height}" alt="${esc(p.description || p.title)}" loading="lazy" decoding="async" />
              <span class="shot-cap">
                <span class="shot-cam ${cam ? '' : 'unknown'}">${CAMERA_ICON}<span>${esc(cam || 'Camera not listed')}</span></span>
                ${p.format && p.format !== '35mm film' ? `<span class="tag">${esc(p.format.replace(' film', ''))}</span>` : ''}
              </span>
            </button>`;
          })
          .join('')
      : `<p class="no-photos">No photos match this filter yet${samples.next ? ' – try loading more.' : '.'}</p>`;
    gallery.querySelectorAll('.shot').forEach((b) => b.addEventListener('click', () => openLightbox(list, Number(b.dataset.i), film)));

    foot.innerHTML = samples.next ? `<button class="btn secondary" id="more">Load more photos</button>` : '';
    foot.querySelector('#more')?.addEventListener('click', more);
  }

  function showNothing() {
    note.innerHTML = '';
    const q = encodeURIComponent(film.name);
    gallery.innerHTML = `<div class="no-photos">
      <p>No freely licensed sample photos of <strong>${esc(film.name)}</strong> on Wikimedia Commons yet. Try these photo communities instead:</p>
      <div class="link-row">
        <a class="btn secondary" href="https://www.flickr.com/search/?text=${q}" target="_blank" rel="noopener">Flickr ↗</a>
        <a class="btn secondary" href="https://www.reddit.com/r/analog/search/?q=${q}&restrict_sr=1" target="_blank" rel="noopener">r/analog ↗</a>
        <a class="btn secondary" href="https://www.lomography.com/search?terms=${q}" target="_blank" rel="noopener">Lomography ↗</a>
      </div>
    </div>`;
    foot.innerHTML = '';
  }

  function showError(err) {
    note.textContent = '';
    gallery.innerHTML = `<div class="no-photos"><p>Couldn’t load sample photos: ${esc(err.message)}</p><button class="btn secondary" id="retry">Try again</button></div>`;
    gallery.querySelector('#retry').addEventListener('click', () => loadSamples(film, ++filmRenderId));
    foot.innerHTML = '';
  }

  more();
}

// ---------- lightbox ----------

function openLightbox(list, index, film) {
  const p = list[index];
  const cam = p.cameras;
  lightbox.innerHTML = `
    <div class="lb-inner">
      <div class="lb-img"><img src="${esc(p.thumb.replace(/\/\d+px-/, '/1600px-'))}" alt="${esc(p.description || p.title)}" /></div>
      <div class="lb-side">
        <button class="lb-close" aria-label="Close">×</button>
        <h3>${esc(p.title)}</h3>
        <dl class="facts">
          <div><dt>Camera</dt><dd>${
            cam.length
              ? cam.map((c) => `${esc(c)}<span class="hint"><a href="${esc(cameraCategoryUrl(c))}" target="_blank" rel="noopener">More photos from this camera ↗</a> · <a href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(c + ' camera')}" target="_blank" rel="noopener">About it ↗</a></span>`).join('<br>')
              : 'Not listed by the photographer'
          }</dd></div>
          ${p.lenses.length ? `<div><dt>Lens</dt><dd>${p.lenses.map(esc).join('<br>')}</dd></div>` : ''}
          <div><dt>Film</dt><dd>${esc(p.films.length ? p.films.join(', ') : film.name)}${p.format ? `<span class="hint">Shot on ${esc(p.format)}</span>` : ''}</dd></div>
          ${p.device ? `<div><dt>File made with</dt><dd>${esc(p.device)}<span class="hint">From the file’s metadata. For film this is usually the scanner, not the camera.</span></dd></div>` : ''}
          ${p.date ? `<div><dt>Date</dt><dd>${esc(p.date)}</dd></div>` : ''}
          <div><dt>Photo by</dt><dd>${esc(p.author)}${p.license ? `<span class="hint">License: ${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}" target="_blank" rel="noopener">${esc(p.license)}</a>` : esc(p.license)}</span>` : ''}</dd></div>
        </dl>
        ${p.description ? `<p class="lb-desc">${esc(p.description)}</p>` : ''}
        <p class="lb-desc"><a href="${esc(p.pageUrl)}" target="_blank" rel="noopener">View on Wikimedia Commons ↗</a></p>
        <div class="lb-nav">
          <button class="btn secondary" data-step="-1" ${index === 0 ? 'disabled' : ''}>← Previous</button>
          <button class="btn secondary" data-step="1" ${index === list.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    </div>`;
  const big = lightbox.querySelector('.lb-img img');
  big.addEventListener('error', () => (big.src = p.thumb), { once: true });
  lightbox.querySelector('.lb-close').addEventListener('click', () => lightbox.close());
  lightbox.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => openLightbox(list, index + Number(b.dataset.step), film)));
  lightbox.onkeydown = (e) => {
    if (e.key === 'ArrowRight' && index < list.length - 1) openLightbox(list, index + 1, film);
    if (e.key === 'ArrowLeft' && index > 0) openLightbox(list, index - 1, film);
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
  const m = location.hash.match(/^#\/film\/([^/?#]+)/);
  if (m) renderFilm(decodeURIComponent(m[1]));
  else renderList();
}

window.addEventListener('hashchange', route);
route();
