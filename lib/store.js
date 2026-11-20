// Private Vercel Blob store: the match centre's only database.
// Reads skip the CDN (useCache:false) so live scores are never served stale.
import { put, get } from '@vercel/blob';

export async function getJSON(path) {
  try {
    const r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    if (e && (e.name === 'BlobNotFoundError' || /not ?found/i.test(e.message || ''))) return null;
    throw e;
  }
}

export async function putJSON(path, obj) {
  await put(path, JSON.stringify(obj), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
}
