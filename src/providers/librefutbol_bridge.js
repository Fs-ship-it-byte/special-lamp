const librefutbol = require('./librefutbol');

// ==========================================
// PUENTE CON REDESIGNED-FORTNIGHT (LA18HD) -- solo canales
// ==========================================
// Este addon se declara proveedor de STREAMS para los ids de canal de la
// parrilla de redesigned-fortnight ("la18hd:<base64url({slug,name})>").
// Cuando el usuario abre un canal de esa parrilla, Stremio le pide
// streams a todos los addons instalados que declaren ese prefijo,
// incluido éste:
//
//   1. se decodifica el nombre del canal desde el propio id (sin red)
//   2. se empareja por nombre normalizado con los canales de LibreFutbol
//   3. se devuelven las fuentes de LibreFutbol de ese canal (ya vienen
//      envueltas en el proxy HLS de este addon, igual que siempre)
//
// Si no hay match, devuelve [] y no pasa nada. No agrega canales nuevos a
// la parrilla: solo suma fuentes alternativas a canales que ya existen.
// ==========================================

const BRIDGE_PREFIX = 'la18hd';

const REGIONS = [
  'argentina', 'mexico', 'usa', 'eeuu', 'chile', 'colombia', 'peru',
  'uruguay', 'espana', 'venezuela', 'ecuador', 'bolivia', 'paraguay',
  'latam', 'brasil', 'brazil',
];

function strip(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// "ESPN 2 (México)" -> { base: "espn2", region: "mexico" }
// "ESPN 2 Mexico HD" -> { base: "espn2", region: "mexico" }
function parseName(name) {
  let s = strip(name);
  let region = '';

  // región entre paréntesis
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => {
    const r = inner.replace(/[^a-z]/g, '');
    if (REGIONS.includes(r)) region = r;
    return ' ';
  });

  // región suelta como palabra
  const words = s.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = [];
  for (const w of words) {
    if (REGIONS.includes(w)) {
      if (!region) region = w;
    } else if (w !== 'hd' && w !== 'fhd' && w !== 'sd' && w !== 'en' && w !== 'vivo') {
      kept.push(w);
    }
  }
  return { base: kept.join(''), region };
}

function regionsCompatible(a, b) {
  // si alguno no declara región, no se descarta; si ambos declaran, deben coincidir
  return !a || !b || a === b;
}

function decodeChannelName(id) {
  try {
    const b64 = id.slice(BRIDGE_PREFIX.length + 1);
    const obj = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return obj && obj.name ? String(obj.name) : null;
  } catch (e) {
    return null;
  }
}

async function getStreamsForLa18hdId(id) {
  const name = decodeChannelName(id);
  if (!name) return [];

  const target = parseName(name);
  if (!target.base) return [];

  let channels;
  try {
    channels = await librefutbol.getChannels();
  } catch (e) {
    console.log(`[bridge] no se pudo leer el catálogo de LibreFutbol: ${e.message}`);
    return [];
  }

  const matches = channels.filter((c) => {
    const p = parseName(c.title);
    return p.base === target.base && regionsCompatible(p.region, target.region);
  });

  if (matches.length === 0) {
    console.log(`[bridge] sin match en LibreFutbol para "${name}"`);
    return [];
  }

  console.log(`[bridge] "${name}" -> ${matches.map((m) => `"${m.title}"`).join(', ')}`);

  const all = [];
  for (const m of matches) {
    try {
      const streams = await librefutbol.getStreams(librefutbol.toId(m.link));
      for (const s of streams) all.push({ ...s, title: `${m.title} - ${s.title}` });
    } catch (e) {
      console.log(`[bridge] error resolviendo "${m.title}": ${e.message}`);
    }
  }
  return all;
}

module.exports = { BRIDGE_PREFIX, parseName, getStreamsForLa18hdId };
