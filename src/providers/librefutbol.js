const cheerio = require('cheerio');
const { getHtml } = require('../http');

const PREFIX = 'librefutbol';
const MAIN_URL = 'https://www.librefutbol2.com'; // revisar si cambia el dominio

// Cache simple en memoria -- el catálogo entero se re-scrapea como mucho
// cada CACHE_TTL_MS, igual que cachedChannels/cachedHome en el provider
// Kotlin original. Evita pegarle al sitio en cada pedido de catálogo.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
let cachedChannels = null;
let cachedAt = 0;

function toId(link) {
  return `${PREFIX}:${Buffer.from(link).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  return Buffer.from(b64, 'base64url').toString('utf8');
}

// ==========================================
// LIMPIEZA DE TÍTULOS -- portado 1:1 de cleanChannelTitle (Kotlin)
// ==========================================
function cleanChannelTitle(title) {
  let clean = title.trim();
  clean = clean.replace(/\.php$/i, '');
  clean = clean.replace(/\s*en vivo por internet\s*$/i, '');
  clean = clean.replace(/\s*en vivo\s*$/i, '');
  clean = clean.replace(/\s*online\s*$/i, '');
  clean = clean.replace(/\s*gratis\s*$/i, '');

  clean = clean
    .split(' ')
    .map((word) => {
      if (word.length > 2 && word === word.toLowerCase()) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word;
    })
    .join(' ');

  return clean.trim();
}

// ==========================================
// FILTRO DE ENLACES BASURA -- portado 1:1 de isValidChannel (Kotlin)
// ==========================================
const JUNK_TITLE_NEEDLES = [
  'telegram',
  'soporte',
  'donar',
  'paypal',
  'mundo latam',
  '🌐',
  '.php',
  'en vivo por internet',
  'inicio',
  'home',
];

function isValidChannel(link, title) {
  const cleanLink = link.trim().replace(/\/$/, '');
  const cleanBase = MAIN_URL.replace(/\/$/, '');
  const lowerTitle = title.toLowerCase();

  return (
    link.length > 0 &&
    title.length > 2 &&
    cleanLink !== cleanBase &&
    !link.includes('#') &&
    !link.includes('javascript:') &&
    !JUNK_TITLE_NEEDLES.some((needle) => lowerTitle.includes(needle))
  );
}

function absolutize(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return `${MAIN_URL}/${href.replace(/^\//, '')}`;
}

// ==========================================
// EXTRACCIÓN DE CANALES -- 3 estrategias en cascada, igual que
// extractChannelsFromHtml (Kotlin). El sitio mezcla canales que están en
// el HTML estático (div#channels) con canales "regionales" que se
// inyectan vía un template string dentro de un <script> (showChannels).
// ==========================================
function extractChannelsFromHtml(html) {
  const $ = cheerio.load(html);
  const channels = [];
  const seenIds = new Set();

  function pushChannel(title, link, img) {
    if (!title || !link || !isValidChannel(link, title)) return;
    if (seenIds.has(link)) return;
    seenIds.add(link);
    channels.push({ title: cleanChannelTitle(title), link, img });
  }

  // 1. div#channels a.channel-card (deportes iniciales)
  $('div#channels a.channel-card').each((_, el) => {
    const $el = $(el);
    const title = $el.find('p').first().text().trim();
    const href = $el.attr('href') || '';
    const link = absolutize(href);
    const imgSrc = $el.find('img').attr('src') || '';
    const img = imgSrc ? absolutize(imgSrc) : '';
    pushChannel(title, link, img);
  });

  // 2. Canales regionales inyectados por JS (bloque showChannels)
  $('script').each((_, el) => {
    const data = $(el).html() || '';
    if (!data.includes('showChannels')) return;

    const channelPattern =
      /<a href="(https:\/\/www\.librefutbol2\.com\/[^"]+\.php)"[^>]*>\s*<div class="live">[\s\S]*?<\/div>\s*<img src="([^"]+)"[^>]*>\s*<p>([^<]+)<\/p>\s*<\/a>/g;

    let match;
    while ((match = channelPattern.exec(data)) !== null) {
      const link = match[1];
      const imgSrc = match[2];
      const title = match[3].trim();
      const img = imgSrc ? absolutize(imgSrc) : '';
      pushChannel(title, link, img);
    }
  });

  // 3. Fallback: cualquier <a href="*.php"> del documento
  if (channels.length === 0) {
    $('a[href*=".php"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const link = absolutize(href);
      if (!link || link === MAIN_URL || link === `${MAIN_URL}/`) return;

      const $img = $el.find('img').first();
      let title = $img.attr('alt')?.trim() || '';
      const imgSrc = $img.attr('src') || '';
      const img = imgSrc ? absolutize(imgSrc) : '';

      if (!title) title = $el.text().trim();
      if (!title) {
        title = link
          .split('/')
          .pop()
          .replace('.php', '')
          .replace(/-/g, ' ');
      }

      pushChannel(title, link, img);
    });
  }

  return channels;
}

let channelsInFlight = null;

// Antes: `if (cachedChannels && ...)` -- un array vacío [] es "truthy" en JS,
// así que si UN scrapeo salía vacío (sitio devolviendo algo raro un
// momento) ese [] quedaba cacheado 10 minutos y TODOS los canales daban
// "0 streams" hasta que venciera. Ahora:
//  - un resultado vacío nunca se cachea;
//  - si el scrapeo falla o sale vacío y hay una copia anterior, se sigue
//    usando esa (aunque haya vencido) en vez de quedarse sin nada;
//  - pedidos simultáneos comparten un solo scrapeo.
async function getChannels() {
  const now = Date.now();
  if (cachedChannels && cachedChannels.length > 0 && now - cachedAt < CACHE_TTL_MS) return cachedChannels;
  if (channelsInFlight) return channelsInFlight;

  channelsInFlight = (async () => {
    try {
      const html = await getHtml(MAIN_URL);
      const channels = extractChannelsFromHtml(html);
      if (channels.length === 0) {
        console.log('[librefutbol] el scrapeo de la home dio 0 canales (no se cachea)');
        if (cachedChannels && cachedChannels.length > 0) return cachedChannels;
        return channels;
      }
      cachedChannels = channels;
      cachedAt = Date.now();
      console.log(`[librefutbol] canales extraídos: ${channels.length}`);
      return channels;
    } catch (e) {
      if (cachedChannels && cachedChannels.length > 0) {
        console.log(`[librefutbol] no se pudo refrescar la home (${e.message}), uso la copia anterior`);
        return cachedChannels;
      }
      throw e;
    } finally {
      channelsInFlight = null;
    }
  })();
  return channelsInFlight;
}

function toMeta(channel) {
  return {
    id: toId(channel.link),
    type: 'tv',
    name: channel.title,
    poster: channel.img || undefined,
    posterShape: 'square',
    background: channel.img || undefined,
    logo: channel.img || undefined,
  };
}

async function getCatalog() {
  const channels = await getChannels();
  return channels.map(toMeta);
}

async function search(query) {
  const channels = await getChannels();
  const q = query.toLowerCase();
  return channels.filter((c) => c.title.toLowerCase().includes(q)).map(toMeta);
}

async function getMeta(id) {
  const link = fromId(id);
  const channels = await getChannels();
  const found = channels.find((c) => c.link === link);
  if (found) return toMeta(found);

  // El canal no está en el catálogo cacheado (pudo haberse agregado
  // después del último scrape) -- devolvemos algo mínimo en vez de null,
  // igual que el fallback de getTvShow en Kotlin.
  return { id, type: 'tv', name: 'Canal en vivo' };
}

// ==========================================
// CANDIDATOS DE EMBED -- el sitio cambió de estructura respecto al Kotlin
// original: ya no lista servidores como <a href>, sino como
// <button class="option" data-src="...core.php?canal=..."> dentro de
// div.options-left. El iframe id="playerFrame" (sin guión, distinto del
// "player-frame" viejo) arranca SIN src en el HTML estático -- el src se
// lo asigna un script al hacer click en cada botón, tomando el data-src.
// No hace falta ejecutar ese JS: el data-src ya trae la URL final en
// texto plano dentro del HTML que ya tenemos.
// ==========================================
function extractCandidatesFromHtml(html) {
  const $ = cheerio.load(html);
  const candidates = [];
  const seen = new Set();

  const push = (raw, label) => {
    if (!raw) return;
    const decoded = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
    if (!decoded || /^(javascript:|#)/i.test(decoded)) return;
    const url = absolutize(decoded);
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, name: (label || '').trim() || `Servidor ${candidates.length + 1}` });
  };

  // 1. Estructura conocida: <button class="option" data-src="...core.php?canal=...">
  $('div.options-left button.option[data-src], button.option[data-src]').each((_, el) => {
    const $el = $(el);
    push($el.attr('data-src'), $el.text().trim() || $el.attr('data-label'));
  });

  // 2. Variantes: cualquier elemento "option"/"server" con data-src/url/link,
  //    o <a class="option" href="...">. Algunos canales (ej. ESPN) pueden
  //    usar otra etiqueta o atributo que el resto.
  if (candidates.length === 0) {
    $('[data-src],[data-url],[data-link],[data-iframe],[data-embed]').each((_, el) => {
      const $el = $(el);
      const raw =
        $el.attr('data-src') || $el.attr('data-url') || $el.attr('data-link') ||
        $el.attr('data-iframe') || $el.attr('data-embed');
      if (el.tagName === 'iframe' || /core\.php|\.php|^https?:/i.test(raw || '')) {
        push(raw, $el.text().trim() || $el.attr('data-label'));
      }
    });
    $('a.option[href], a.server[href], .options-left a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      if (/core\.php|player|embed/i.test(href)) push(href, $el.text().trim());
    });
  }

  // 3. Cualquier mención a core.php?... en el HTML crudo (incluye scripts
  //    con la lista de servidores como JSON/strings).
  if (candidates.length === 0) {
    const re = /["'(]((?:https?:)?\\?\/\\?\/[^"'\s<>)]*core\.php\?[^"'\s<>)]+|[^"'\s<>)]*core\.php\?[^"'\s<>)]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) push(m[1], '');
  }

  // 4. Red de seguridad: iframe con src ya presente en el HTML estático.
  if (candidates.length === 0) {
    const staticSrc =
      $('iframe#playerFrame').attr('src') || $('iframe#player-frame').attr('src') || '';
    if (staticSrc) push(staticSrc, 'Opción 1');
  }

  return candidates;
}

function logNoCandidates(channelUrl, html) {
  const count = (re) => (html.match(re) || []).length;
  const title = ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80);
  console.log(
    `[librefutbol] diagnóstico ${channelUrl}: html=${html.length}ch title="${title}" ` +
      `option=${count(/class=["'][^"']*option/gi)} data-src=${count(/data-src/gi)} ` +
      `core.php=${count(/core\.php/gi)} iframe=${count(/<iframe/gi)} ` +
      `playerFrame=${count(/playerFrame/gi)} cloudflare=${/just a moment|cf-chl|challenge-platform/i.test(html)}`
  );
}

async function getEmbedCandidates(channelUrl, { deadline } = {}) {
  let html;
  try {
    html = await getHtml(channelUrl, { headers: { Referer: MAIN_URL } });
  } catch (e) {
    console.log(`[librefutbol] no se pudo cargar el canal ${channelUrl}: ${e.message}`);
    html = null;
  }

  let candidates = html ? extractCandidatesFromHtml(html) : [];

  // Plan B: si el HTML estático no trae servidores (o ni cargó), se lee el
  // DOM ya renderizado con Chromium.
  if (candidates.length === 0) {
    if (html) logNoCandidates(channelUrl, html);
    console.log('[librefutbol] sin candidatos en el HTML estático, pruebo con el navegador');
    try {
      const { collectCandidatesViaBrowser } = require('../extractors/browser');
      const viaBrowser = await collectCandidatesViaBrowser(channelUrl, { deadline });
      candidates = viaBrowser.map((c, i) => ({ url: c.url, name: c.name || `Servidor ${i + 1}` }));
    } catch (e) {
      console.log(`[librefutbol] falló el plan B de candidatos: ${e.message}`);
    }
  }

  console.log(`[librefutbol] ${candidates.length} candidato(s) de embed para ${channelUrl}`);
  return candidates;
}

// ==========================================
// RESOLUCIÓN DE playlist.php a partir de un candidato de embed --
// intentamos match directo primero (el caso más simple); si no aparece,
// seguimos hasta 2 niveles de <iframe src="..."> anidados por si el
// core.php en sí mismo delega en otro embed antes de llegar al script con
// el m3u8 (mismo patrón defensivo que resolveMutantHls en el otro addon).
// ==========================================
async function resolveEmbedToPlaylist(embedUrl, referer, depth = 0) {
  if (depth > 2) return null;

  let html;
  try {
    html = await getHtml(embedUrl, { headers: { Referer: referer } });
  } catch (e) {
    console.log(`[librefutbol] no se pudo cargar el embed ${embedUrl}: ${e.message}`);
    return null;
  }

  const direct = html.match(/["'](https:[^"']+playlist\.php[^"']+)["']/);
  if (direct) {
    return direct[1].replace(/\\\//g, '/');
  }

  const $ = cheerio.load(html);
  const nestedSrc = $('iframe').attr('src') || '';
  if (nestedSrc) {
    const nestedUrl = absolutize(nestedSrc);
    return resolveEmbedToPlaylist(nestedUrl, embedUrl, depth + 1);
  }

  console.log(`[librefutbol] no se encontró playlist.php ni iframe anidado en ${embedUrl}`);
  return null;
}

// ==========================================
// STREAMS
// ==========================================
// Presupuesto total por pedido de streams. Se reparte entre cargar la
// página y probar cada servidor; lo que no alcance se devuelve parcial.
const STREAM_BUDGET_MS = parseInt(process.env.LIBREFUTBOL_BUDGET_MS || '35000', 10);
const PARALLEL_MS = parseInt(process.env.LIBREFUTBOL_PARALLEL_MS || '12000', 10);
const PER_CANDIDATE_MS = parseInt(process.env.LIBREFUTBOL_PER_SERVER_MS || '10000', 10);

// Cache corto de streams ya resueltos + dedupe de pedidos en vuelo.
// Stremio suele pedir los streams del mismo canal más de una vez seguidas
// (abrir la ficha, darle play, reintentos); antes cada pedido abría su
// propio Chromium para lo mismo. TTL corto porque el sig del CDN vence.
const STREAM_CACHE_TTL_MS = parseInt(process.env.STREAM_CACHE_TTL_MS || '60000', 10);
const streamCache = new Map(); // id -> { at, streams }
const streamInFlight = new Map(); // id -> Promise

const candidateCache = new Map(); // channelUrl -> { at, candidates }
const CANDIDATE_TTL_MS = 10 * 60 * 1000;

async function getEmbedCandidatesCached(channelUrl, deadline) {
  const hit = candidateCache.get(channelUrl);
  if (hit && Date.now() - hit.at < CANDIDATE_TTL_MS) return hit.candidates;
  const candidates = await getEmbedCandidates(channelUrl, { deadline });
  if (candidates.length > 0) candidateCache.set(channelUrl, { at: Date.now(), candidates });
  return candidates;
}

async function resolveStreams(id) {
  const t0 = Date.now();
  const deadline = t0 + STREAM_BUDGET_MS;
  const channelUrl = fromId(id);
  const candidates = await getEmbedCandidatesCached(channelUrl, deadline);

  if (candidates.length === 0) {
    console.log(`[librefutbol] sin candidatos de embed para ${channelUrl}`);
    return [];
  }

  const { buildProxyPlaylistUrl } = require('../hlsproxy');
  const { resolvePlaylistsViaBrowser } = require('../extractors/browser');

  // Hasta 2 intentos: si el primero no devuelve NADA (Chromium recién
  // caído, página que no cargó) y queda tiempo, se reintenta con página
  // limpia. Si el primero devolvió algo, aunque sea parcial, no se repite.
  let resolved = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (deadline - Date.now() < 5000) break;
    resolved = await resolvePlaylistsViaBrowser(channelUrl, candidates, {
      deadline,
      perCandidateMs: PER_CANDIDATE_MS,
      parallelMs: PARALLEL_MS,
    });
    if (resolved.length > 0) break;
    console.log(`[librefutbol] intento ${attempt}: 0 servidores resueltos${attempt < 2 ? ', reintento' : ''}`);
  }

  const streams = resolved.map(({ candidate, url, headers }) => ({
    name: 'LibreFutbol',
    title: candidate.name,
    url: buildProxyPlaylistUrl(url, headers),
    type: 'hls',
    behaviorHints: { notWebReady: true },
  }));

  console.log(
    `[librefutbol] streams resueltos: ${streams.length} de ${candidates.length} candidato(s) en ${Date.now() - t0}ms`
  );
  // Resultado parcial (menos servidores que botones): se devuelve igual,
  // pero no se cachea, para que el próximo pedido pueda completar.
  streams.partial = streams.length < candidates.length;
  return streams;
}

async function getStreams(id) {
  const cached = streamCache.get(id);
  if (cached && Date.now() - cached.at < STREAM_CACHE_TTL_MS) {
    console.log(`[librefutbol] streams desde cache (${cached.streams.length})`);
    return cached.streams;
  }
  if (streamInFlight.has(id)) return streamInFlight.get(id);

  const p = resolveStreams(id)
    .then((streams) => {
      if (streams.length > 0 && !streams.partial) {
        streamCache.set(id, { at: Date.now(), streams });
        if (streamCache.size > 200) {
          const cutoff = Date.now() - STREAM_CACHE_TTL_MS;
          for (const [k, v] of streamCache) if (v.at < cutoff) streamCache.delete(k);
        }
      }
      return streams;
    })
    .finally(() => streamInFlight.delete(id));
  streamInFlight.set(id, p);
  return p;
}

module.exports = { PREFIX, MAIN_URL, getCatalog, search, getMeta, getStreams };
