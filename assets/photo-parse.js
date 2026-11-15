// Turns a Wikimedia Commons API "page" into a photo object for the site.
// Shared by the browser (assets/commons.js) and the GitHub Action (scripts/fetch-photos.mjs),
// so it takes the HTML-to-text function as a parameter.

import { CATEGORY_PREFIX } from './match.js';

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

export function parsePhoto(page, TEXT) {
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
    site: 'Wikimedia Commons',
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

export const PHOTO_PROPS = {
  prop: 'imageinfo|categories',
  cllimit: 'max',
  iiprop: 'url|extmetadata|metadata|mime',
  iiurlwidth: '800',
  iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|DateTimeOriginal|ImageDescription',
};
