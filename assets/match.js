// Matching a shop film name ("ILFORD Delta 100 Professional") to a Wikimedia
// Commons category ("Category:Photographs taken on Ilford Delta 100").
// Plain functions with no browser or network code, so they can also be tested in Node.

export const CATEGORY_PREFIX = 'Category:Photographs taken on ';

// Words that don't help tell films apart.
const STOP_WORDS = new Set(['professional', 'pro', 'film', 'eastman', 'classic', 'plus', 'super', 'the', 'of', 'and', 'edition', '35mm', 'mm']);
// Shop brand spellings → the spelling Commons usually uses.
const ALIASES = { fujifilm: 'fuji', agfaphoto: 'agfa', 'ilfordphoto': 'ilford' };
export const BRANDS = new Set(['kodak', 'ilford', 'fuji', 'kentmere', 'rollei', 'agfa', 'foma', 'lomography', 'harman', 'cinestill', 'adox', 'ferrania', 'polaroid']);

export function tokens(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`]/g, '')
    .replace(/(\w)-(\w)/g, '$1$2') // tri-x → trix, t-max → tmax
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => ALIASES[t] || t)
    .filter((t) => !STOP_WORDS.has(t));
}

// Returns the best matching category title, or null.
// Rule: every meaningful word in the category must also be in the film name,
// and the category must name something beyond the brand (so "Kodak films"
// never matches, and "Kodak Gold 100" never matches "Kodak Gold 200").
export function bestCategory(filmName, categoryTitles) {
  const film = new Set(tokens(filmName));
  let best = null;
  let bestScore = 0;
  for (const title of categoryTitles) {
    if (!title.startsWith(CATEGORY_PREFIX)) continue;
    const cand = tokens(title.slice(CATEGORY_PREFIX.length));
    if (cand.length === 0) continue;
    if (!cand.every((t) => film.has(t))) continue;
    const specific = cand.filter((t) => !BRANDS.has(t) && !/^\d+$/.test(t));
    // Brand + number only ("Fujifilm 200", "Kentmere 400") is fine when it covers
    // nearly the whole film name, so "Kodak 400" can't grab every Kodak 400 film.
    if (specific.length === 0 && !(cand.some((t) => /^\d+$/.test(t)) && film.size - cand.length <= 1 && cand.length >= 2)) continue;
    // More matching words = more specific = better. A matching ISO number counts extra.
    const score = cand.length + cand.filter((t) => /^\d+$/.test(t)).length * 0.5;
    if (score > bestScore) {
      best = title;
      bestScore = score;
    }
  }
  return best;
}

// The words to use for a plain text search when there's no category.
export function searchPhrase(filmName) {
  return filmName.replace(/\b(professional|eastman)\b/gi, '').replace(/\s+/g, ' ').trim();
}

// Search terms to find candidate categories, most specific first.
// "Kodak Professional Tri-X 400" → ['intitle:"Tri-X"', 'intitle:"Kodak"']
export function searchWords(filmName) {
  const words = searchPhrase(filmName)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const isBrand = (w) => BRANDS.has(tokens(w)[0]);
  const distinctive = words.find((w) => !isBrand(w) && !/^\d+$/.test(w) && tokens(w).length > 0);
  const brand = words.find(isBrand) || words[0];
  const out = [];
  if (distinctive) out.push(`intitle:"${distinctive}"`);
  if (brand) {
    out.push(`intitle:"${brand}"`);
    // The shop says "Fujifilm"/"AgfaPhoto"; Commons often says "Fuji"/"Agfa".
    const alias = { fujifilm: 'Fuji', agfaphoto: 'Agfa' }[brand.toLowerCase()];
    if (alias) out.push(`intitle:"${alias}"`);
  }
  return out;
}
