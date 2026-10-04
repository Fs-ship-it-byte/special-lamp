const librefutbol = require('./librefutbol');

// ==========================================
// Este addon ya NO tiene catálogo propio. Solo responde al resource
// "stream" para ids de LA18HD (prefix "la18hd", el mismo que usa el
// addon redesigned-fortnight) -- cuando Stremio pide streams de un canal
// de LA18HD, este addon también responde (porque declara el mismo
// idPrefix), agregando las fuentes de librefutbol2.com como opciones
// extra "Libre Futbol 1", "Libre Futbol 2", etc. junto a las que ya
// devuelve el addon de LA18HD. Son dos addons separados contestando para
// el mismo id, no un catálogo combinado.
// ==========================================

const LA18HD_PREFIX = 'la18hd';

function normalize(name) {
  return (name || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '')
    // "ESPN HD" / "ESPN en vivo" en un sitio vs "ESPN" en el otro: mismo canal.
    .replace(/(ENVIVO|HD)$/, '');
}

// Mismo canal, nombre distinto entre los dos sitios. Agregar más pares
// acá si aparecen otros rebrands. (Respaldo: solo se usa para canales que
// NO están en la tabla explícita de más abajo.)
const ALIASES = {
  DSPORTS: 'DIRECTVSPORTS',
  DSPORTS2: 'DIRECTVSPORTS2',
  DSPORTSPLUS: 'DIRECTVSPORTSPLUS',
};

// ==========================================
// TABLA EXPLÍCITA: nombre del canal en LA18HD -> página en librefutbol2.com
// ==========================================
// Armada con la grilla REAL de canales que se ve en el navegador
// (section#channelGrid). Comparar por nombre contra el catálogo que se
// scrapea con fetch fallaba: ese HTML es otra variante que lista páginas
// que ya no existen (ej. "ESPN" -> espn-en-vivo-online.php, que ya no está
// en la grilla real y no resuelve ningún servidor) y no trae otras que sí
// existen (ej. ESPN Premium Argentina).
//
// El valor es el slug de la página (sin ".php"). Para cambiar a qué página
// va un canal, se edita SOLO esta tabla.
//
// OJO con "ESPN": la grilla tiene dos páginas cuyo nombre visible y cuya URL
// no coinciden entre sí (visible "ESPN Colombia" -> URL espn-argentina, y
// visible "ESPN Argentina" -> URL espn-colombia). Se usa la URL de
// "espn-argentina" para el "ESPN" de LA18HD; si resulta ser la otra, se
// intercambia por 'espn-colombia-en-vivo-online'.
const SLUG_BY_LA18HD_NAME = {
  // ESPN
  'ESPN': 'espn-argentina-en-vivo-online',
  'ESPN 2': 'espn-2-en-vivo-online',
  'ESPN 3': 'espn-3-en-vivo-online',
  'ESPN 4': 'espn-4-en-vivo-online',
  'ESPN 5': 'espn-5-en-vivo-online',
  'ESPN 6': 'espn-6-en-vivo-online',
  'ESPN 7': 'espn-7-en-vivo-online',
  'ESPN Premium (Argentina)': 'espn-premium-argentina-en-vivo-online',
  'ESPN (México)': 'espn-mexico-en-vivo-online',
  'ESPN 2 (México)': 'espn-2-mexico-en-vivo-online',
  'ESPN 3 (México)': 'espn-3-mexico-en-vivo-online',
  'ESPN 4 (México)': 'espn-4-mexico-en-vivo-online',
  // DSports
  'DSports': 'directv-sports-en-vivo-online',
  'DSports 2': 'directv-sports-2-en-vivo-online',
  'DSports Plus': 'directv-sports-plus-en-vivo-online',
  // Fox Sports
  'Fox Sports (Argentina)': 'fox-sports-en-vivo-online',
  'Fox Sports 2 (Argentina)': 'fox-sports-2-en-vivo-online',
  'Fox Sports 3 (Argentina)': 'fox-sports-3-en-vivo-online',
  'Fox Sports (México)': 'fox-sports-mexico-en-vivo-online',
  'Fox Sports 2 (México)': 'fox-sports-2-mexico-en-vivo-online',
  'Fox Sports 3 (México)': 'fox-sports-3-mexico-en-vivo-online',
  'Fox Sports Premium (México)': 'fox-sports-premium-en-vivo-online',
  // Otros
  'TyC Sports (Argentina)': 'tyc-sports-en-vivo-online',
  'Liga 1 Max (Perú)': 'liga-1-max-en-vivo-online',
  'TUDN (México)': 'tudn-en-vivo-online',
  'TUDN (USA)': 'tudn-en-vivo-online',
  'Bein Sports Xtra Español (USA)': 'bein-sports-xtra-en-vivo-online',
  'Sky Sports La Liga (España)': 'sky-sports-la-liga-en-vivo-online',
};
const EXPLICIT = Object.fromEntries(
  Object.entries(SLUG_BY_LA18HD_NAME).map(([name, slug]) => [normalize(name), slug])
);

function decodeLa18hdName(id) {
  try {
    const b64 = id.replace(`${LA18HD_PREFIX}:`, '');
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return data.name || null;
  } catch (e) {
    return null;
  }
}

async function getStreamsForLa18hdId(id) {
  const name = decodeLa18hdName(id);
  if (!name) return [];

  const target = normalize(name);
  const aliasedTarget = ALIASES[target] || target;

  let matchId;
  let matchName;

  // 1) Tabla explícita (ver arriba).
  const slug = EXPLICIT[target];
  if (slug) {
    matchId = librefutbol.toId(`${librefutbol.MAIN_URL}/${slug}.php`);
    matchName = slug;
  } else {
    // 2) Respaldo: comparar por nombre contra el catálogo scrapeado.
    let catalog;
    try {
      catalog = await librefutbol.getCatalog(); // cachea internamente, no pega siempre a la red
    } catch (e) {
      console.log(`[la18hd-bridge] no se pudo listar el catálogo de librefutbol: ${e.message}`);
      return [];
    }
    const match = catalog.find((c) => {
      const n = normalize(c.name);
      return n === target || n === aliasedTarget;
    });
    if (!match) {
      console.log(`[la18hd-bridge] "${name}" sin equivalente en librefutbol2.com`);
      return [];
    }
    matchId = match.id;
    matchName = match.name;
  }

  console.log(`[la18hd-bridge] "${name}" -> "${matchName}" en librefutbol2.com${slug ? ' (tabla)' : ' (por nombre)'}`);
  let streams;
  try {
    streams = await librefutbol.getStreams(matchId);
  } catch (e) {
    console.log(`[la18hd-bridge] error resolviendo "${matchName}": ${e.message}`);
    return [];
  }

  return streams.map((s, i) => ({
    ...s,
    name: 'Libre Futbol',
    title: `Libre Futbol ${i + 1}`,
  }));
}

module.exports = { LA18HD_PREFIX, getStreamsForLa18hdId };
