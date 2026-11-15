# Shelf Life: 35mm film in stock at Graination

A small website that shows every **35mm film currently in stock** at
[graination.ca](https://graination.ca/product-category/film/35mm-film/).
Open a film to see **real photos shot on it** and **the camera each photo was taken with**.

## How it works

| Part | What it does | Where |
| --- | --- | --- |
| Stock list | A GitHub Action runs **every hour**, asks the shop which 35mm films are in stock, and saves the result to `data/films.json`. A commit is made only when stock changes. | `scripts/fetch-stock.mjs`, `.github/workflows/update.yml` |
| Website | Plain HTML, CSS and JavaScript, no build step. It reads `data/films.json` and shows the films with search, type and ISO filters, and sorting. | `index.html`, `assets/` |
| Sample photos | When you open a film, your browser loads freely licensed photos from **Wikimedia Commons**: first from the collection "Photographs taken on *film name*", otherwise from a text search limited to photos filed as film photos. The camera comes from the photographer's "Taken with *camera*" tag. | `assets/commons.js`, `assets/match.js` |

Why the shop isn't read live from the browser: the shop's data feed doesn't
allow other websites to read it (no CORS permission), so the hourly
GitHub Action reads it instead.

## Publishing it (GitHub Pages)

1. **Pages needs a public repo on GitHub's free plan.** This repo is private,
   so either make it public (Settings → General → Danger Zone → Change visibility)
   or use a paid GitHub plan.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Make sure this code is on the repo's **default branch** (scheduled Actions
   only run there), then open the **Actions** tab, choose
   **Update stock and publish site**, and click **Run workflow**.
4. The site appears at `https://<your-username>.github.io/GrainationPreview/`.
   After that it updates itself every hour.

Optional: Wikimedia asks automated tools to say who runs them. Add a repository
variable `COMMONS_CONTACT` (Settings → Secrets and variables → Actions →
Variables) with a URL or email, and the hourly job uses it when it refreshes
`data/commons-categories.json`. This file only makes film pages a little faster;
the site works without it.

## Fixing a film's photos

If a film shows the wrong photos, or none, edit `data/commons-overrides.json`:

```json
{
  "Kentmere Pan 400": "Category:Photographs taken on Kentmere 400",
  "FUJIFILM 400": "\"Fujicolor 400\"",
  "Some Film": null
}
```

- Key: the film name exactly as the site shows it.
- `"Category:…"`: use that Wikimedia Commons collection.
- `"\"words\""`: use a text search for those words.
- `null`: show no photos.

## Running it on your computer

```bash
node scripts/fetch-stock.mjs      # refresh data/films.json (needs Node 18+)
python3 -m http.server 8000       # then open http://localhost:8000
```

Photos are © their authors and shown under the license listed with each one.
This project is not affiliated with Graination.
