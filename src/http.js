const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookieFactory = require('fetch-cookie');

// Jar compartido: el sitio fachada (librefutbol2.com) no lo necesita para
// nada en particular hasta donde sabemos, pero lo dejamos por las dudas
// (mismo patrón que el resto de los providers de este estilo) y porque no
// cuesta nada tenerlo.
const jar = new CookieJar();
const fetchWithCookies = fetchCookieFactory(fetch, jar);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'X-Requested-With': 'XMLHttpRequest',
};

// El CDN real de video vive en un dominio totalmente distinto al del sitio
// fachada (ver comentario en el provider), y solo acepta Origin/Referer de
// su propio dominio embed -- portado 1:1 del interceptor OkHttp del
// TvLibrefutbolProvider original.
const VIDEO_CDN_HOST_MATCHES = ['ksdjugfssddeports.com', 'playlist.php', '.ts', ':9092'];
const VIDEO_CDN_HEADERS = {
  Origin: 'https://embed.ksdjugfssddeports.com',
  Referer: 'https://embed.ksdjugfssddeports.com/',
};

function isVideoCdnUrl(url) {
  return VIDEO_CDN_HOST_MATCHES.some((needle) => url.includes(needle));
}

async function getHtml(url, opts = {}) {
  const extraHeaders = isVideoCdnUrl(url) ? VIDEO_CDN_HEADERS : {};
  const res = await fetchWithCookies(url, {
    headers: { ...DEFAULT_HEADERS, ...extraHeaders, ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
    } catch (e) {
      /* ignore */
    }
    const err = new Error(`GET ${url} -> HTTP ${res.status}${snippet ? ` | body: ${snippet}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

module.exports = { getHtml, DEFAULT_HEADERS, VIDEO_CDN_HEADERS, isVideoCdnUrl, fetchWithCookies, jar };
