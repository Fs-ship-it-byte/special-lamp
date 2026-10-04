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
    .replace(/[^A-Z0-9]/g, '');
}

// Mismo canal, nombre distinto entre los dos sitios. Agregar más pares
// acá si aparecen otros rebrands.
const ALIASES = {
  DSPORTS: 'DIRECTVSPORTS',
  DSPORTS2: 'DIRECTVSPORTS2',
  DSPORTSPLUS: 'DIRECTVSPORTSPLUS',
};

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

  console.log(`[la18hd-bridge] "${name}" -> "${match.name}" en librefutbol2.com`);
  let streams;
  try {
    streams = await librefutbol.getStreams(match.id);
  } catch (e) {
    console.log(`[la18hd-bridge] error resolviendo "${match.name}": ${e.message}`);
    return [];
  }

  return streams.map((s, i) => ({
    ...s,
    name: 'Libre Futbol',
    title: `Libre Futbol ${i + 1}`,
  }));
}

module.exports = { LA18HD_PREFIX, getStreamsForLa18hdId };
