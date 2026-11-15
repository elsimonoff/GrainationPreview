// Flickr support, used to find photos taken with your preferred camera
// (e.g. Ricoh R1s). Wikimedia Commons has almost none of those, while Flickr
// film photographers usually tag both camera and film ("ricohr1s", "kodakgold200").
//
// Needs a free Flickr API key in data/settings.json → "flickrApiKey".
// Get one at https://www.flickr.com/services/apps/create/ (choose non-commercial).
// Every photo is shown with its owner's name and links back to its Flickr page,
// as Flickr's API terms require.

const API = 'https://api.flickr.com/services/rest/';
const EXTRAS = 'url_m,url_z,url_l,owner_name,license,date_taken,tags,description,path_alias';

// Flickr's license ids → readable names.
const LICENSES = {
  0: ['All rights reserved', null],
  1: ['CC BY-NC-SA 2.0', 'https://creativecommons.org/licenses/by-nc-sa/2.0/'],
  2: ['CC BY-NC 2.0', 'https://creativecommons.org/licenses/by-nc/2.0/'],
  3: ['CC BY-NC-ND 2.0', 'https://creativecommons.org/licenses/by-nc-nd/2.0/'],
  4: ['CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'],
  5: ['CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/'],
  6: ['CC BY-ND 2.0', 'https://creativecommons.org/licenses/by-nd/2.0/'],
  7: ['No known copyright restrictions', 'https://www.flickr.com/commons/usage/'],
  8: ['United States Government Work', null],
  9: ['CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  10: ['Public Domain Mark', 'https://creativecommons.org/publicdomain/mark/1.0/'],
  11: ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  12: ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
  13: ['CC BY-ND 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/'],
  14: ['CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/'],
  15: ['CC BY-NC-SA 4.0', 'https://creativecommons.org/licenses/by-nc-sa/4.0/'],
  16: ['CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/'],
};

export const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const TEXT = (html = '') => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
};

async function call(apiKey, params) {
  const url = `${API}?${new URLSearchParams({ api_key: apiKey, format: 'json', nojsoncallback: '1', ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Flickr answered ${res.status}`);
  const json = await res.json();
  if (json.stat !== 'ok') throw new Error(`Flickr: ${json.message || 'error'}`);
  return json;
}

// Converts a Flickr search result into the same shape as Commons photos.
function toPhoto(p, cameraNames) {
  const thumb = p.url_z || p.url_m;
  if (!thumb) return null;
  const tags = String(p.tags || '').split(/\s+/).filter(Boolean);
  const description = TEXT(p.description?._content || '');
  const [license, licenseUrl] = LICENSES[p.license] || ['', null];
  const owner = p.pathalias || p.owner;
  const cameras = cameraNames.filter((n) => tags.includes(squash(n)));
  return {
    site: 'Flickr',
    title: TEXT(p.title || '') || 'Untitled',
    pageUrl: `https://www.flickr.com/photos/${encodeURIComponent(owner)}/${encodeURIComponent(p.id)}`,
    thumb,
    width: Number(p.width_z || p.width_m) || undefined,
    height: Number(p.height_z || p.height_m) || undefined,
    big: p.url_l || p.url_z || p.url_m,
    cameras,
    lenses: [],
    format: tags.includes('35mm') || tags.includes('35mmfilm') ? '35mm film' : null,
    films: [],
    tags,
    device: null,
    date: (p.datetaken || '').slice(0, 10) || null,
    author: p.ownername || 'Flickr user',
    license,
    licenseUrl,
    description: description.slice(0, 280),
  };
}

// Searches Flickr for photos tagged with any of the cameras (and, optionally, matching some text).
export async function searchCameraPhotos(apiKey, cameraNames, text = '', perPage = 100, creativeCommonsOnly = false) {
  const params = {
    method: 'flickr.photos.search',
    tags: cameraNames.map(squash).join(','),
    tag_mode: 'any',
    extras: EXTRAS,
    per_page: String(perPage),
    sort: 'relevance',
    content_type: '1', // photos only, no screenshots
    media: 'photos',
    safe_search: '1',
  };
  if (text) params.text = text;
  if (creativeCommonsOnly) params.license = '1,2,3,4,5,6,7,9,10,11,12,13,14,15,16';
  const json = await call(apiKey, params);
  return (json.photos?.photo || []).map((p) => toPhoto(p, cameraNames)).filter(Boolean);
}
