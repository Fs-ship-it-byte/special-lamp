const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookieFactory = require('fetch-cookie');

const jar = new CookieJar();
const fetchWithCookies = fetchCookieFactory(fetch, jar);

// OJO: antes acá se mandaba también 'X-Requested-With: XMLHttpRequest' en
// TODOS los pedidos. Eso le dice al sitio "soy una llamada AJAX", y hay
// sitios que contestan otra cosa (HTML parcial, bloqueo, challenge) --
// el scrapeo de la home devolvía 0 canales y ese resultado quedaba
// cacheado. redesigned-fortnight no lo manda y anda bien, así que se saca.
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

// El CDN real de video vive en un dominio distinto al del sitio fachada y
// solo acepta Origin/Referer de su propio dominio embed.
// (Antes también matcheaba '.ts' y ':9092' como substring suelto, lo que
// podía pegarle esos headers a URLs que no tenían nada que ver.)
const VIDEO_CDN_HOST_MATCHES = ['ksdjugfssddeports.com', 'playlist.php'];
const VIDEO_CDN_HEADERS = {
  Origin: 'https://embed.ksdjugfssddeports.com',
  Referer: 'https://embed.ksdjugfssddeports.com/',
};

const FETCH_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '10000', 10);

function isVideoCdnUrl(url) {
  return VIDEO_CDN_HOST_MATCHES.some((needle) => url.includes(needle));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtmlOnce(url, opts) {
  // Bug anterior: `{ headers: {...todos}, ...opts }` hacía que, si opts
  // traía "headers" (ej. solo Referer), REEMPLAZARA a todos los headers
  // -> el pedido salía sin User-Agent de navegador. Ahora se separan y se
  // mezclan bien.
  const { headers: optHeaders, ...rest } = opts;
  const extraHeaders = isVideoCdnUrl(url) ? VIDEO_CDN_HEADERS : {};
  const res = await fetchWithCookies(url, {
    timeout: FETCH_TIMEOUT_MS,
    ...rest,
    headers: { ...DEFAULT_HEADERS, ...extraHeaders, ...(optHeaders || {}) },
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

// Un reintento ante fallos transitorios (timeout, reset de conexión, 5xx,
// 429). Los 4xx "de verdad" (403/404) no se reintentan.
async function getHtml(url, opts = {}) {
  try {
    return await getHtmlOnce(url, opts);
  } catch (e) {
    const transient = !e.status || e.status >= 500 || e.status === 429;
    if (!transient) throw e;
    console.log(`[http] fallo transitorio en ${url} (${e.message.slice(0, 120)}), reintentando...`);
    await sleep(400);
    return getHtmlOnce(url, opts);
  }
}

module.exports = { getHtml, DEFAULT_HEADERS, VIDEO_CDN_HEADERS, isVideoCdnUrl, fetchWithCookies, jar };
