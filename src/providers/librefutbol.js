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

async function getChannels() {
  const now = Date.now();
  if (cachedChannels && now - cachedAt < CACHE_TTL_MS) return cachedChannels;

  const html = await getHtml(MAIN_URL);
  const channels = extractChannelsFromHtml(html);
  cachedChannels = channels;
  cachedAt = now;
  console.log(`[librefutbol] canales extraídos: ${channels.length}`);
  return channels;
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
async function getEmbedCandidates(channelUrl) {
  let html;
  try {
    html = await getHtml(channelUrl, { headers: { Referer: MAIN_URL } });
  } catch (e) {
    console.log(`[librefutbol] no se pudo cargar el canal ${channelUrl}: ${e.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const candidates = [];
  const seen = new Set();

  $('div.options-left button.option[data-src], button.option[data-src]').each((_, el) => {
    const $el = $(el);
    const dataSrc = $el.attr('data-src') || '';
    if (!dataSrc) return;
    const url = absolutize(dataSrc);
    if (seen.has(url)) return;
    seen.add(url);
    const label = $el.text().trim() || $el.attr('data-label') || '';
    candidates.push({ url, name: label || `Servidor ${candidates.length + 1}` });
  });

  // Red de seguridad por si alguna página vieja/regional todavía sirve el
  // iframe con src ya presente en el HTML estático (estructura del
  // Kotlin original).
  if (candidates.length === 0) {
    const staticSrc =
      $('iframe#playerFrame').attr('src') || $('iframe#player-frame').attr('src') || '';
    if (staticSrc) {
      candidates.push({ url: absolutize(staticSrc), name: 'Opción 1' });
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

async function getStreams(id) {
  const channelUrl = fromId(id);
  const candidates = await getEmbedCandidates(channelUrl);

  if (candidates.length === 0) {
    console.log(`[librefutbol] sin candidatos de embed para ${channelUrl}`);
    return [];
  }

  const { buildProxyPlaylistUrl } = require('../hlsproxy');
  const { resolvePlaylistViaBrowser } = require('../extractors/browser');

  // Confirmado: el sig que aparece en el HTML estático de core.php es un
  // señuelo fijo (siempre el mismo string, nunca cambia entre sesiones) y
  // además probamos que "verificarlo" con un GET normal antes de usarlo
  // parecía funcionar pero luego el proxy real recibía 403 igual --
  // fuerte indicio de que es de un solo uso y nuestra propia verificación
  // lo quemaba. Vamos directo al navegador siempre, sin ese paso previo.
  const streams = [];
  for (const candidate of candidates) {
    const viaBrowser = await resolvePlaylistViaBrowser(channelUrl, candidate.url);
    if (!viaBrowser) {
      console.log(`[librefutbol] no se pudo resolver ${candidate.name} con el navegador`);
      continue;
    }

    streams.push({
      name: 'LibreFutbol',
      title: candidate.name,
      url: buildProxyPlaylistUrl(viaBrowser.url, viaBrowser.headers),
      type: 'hls',
      behaviorHints: { notWebReady: true },
    });
  }

  console.log(`[librefutbol] streams resueltos: ${streams.length} de ${candidates.length} candidato(s)`);
  return streams;
}

module.exports = { PREFIX, MAIN_URL, getCatalog, search, getMeta, getStreams };
