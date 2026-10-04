const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const librefutbol = require('./providers/librefutbol');
const la18hdBridge = require('./providers/la18hd_bridge');
const { handlePlaylistProxy, handleSegmentProxy, handleDirectProxy } = require('./hlsproxy');

// Ya no tiene catálogo propio: solo responde "stream" para ids de
// LA18HD (mismo idPrefix que ese addon), agregando fuentes de
// librefutbol2.com como opciones extra junto a las que ya da LA18HD. Dos
// addons instalados, el mismo id, Stremio junta los resultados de los dos
// en la lista de streams -- no hay catálogo ni meta acá.
const manifest = {
  id: 'community.storm.librefutbol',
  version: '0.2.0',
  name: 'LibreFutbol (fuentes extra para LA18HD)',
  description:
    'Sin catálogo propio: agrega fuentes de librefutbol2.com como opción extra a los canales del addon de LA18HD.',
  logo: 'https://i.ibb.co/q3v6R9qQ/librefutbol.jpg',
  resources: [{ name: 'stream', types: ['tv'], idPrefixes: [la18hdBridge.LA18HD_PREFIX] }],
  types: ['tv'],
  catalogs: [],
  idPrefixes: [la18hdBridge.LA18HD_PREFIX],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ id }) => {
  try {
    const streams = await la18hdBridge.getStreamsForLa18hdId(id);
    console.log(`total streams devueltos: ${streams.length}`);
    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));

app.get('/hlsproxy/playlist/:token/:file', handlePlaylistProxy);
app.get('/hlsproxy/segment/:token/:file', handleSegmentProxy);
app.get('/hlsproxy/direct/:token/:file', handleDirectProxy);

// ==========================================
// DEBUG: inspeccionar en vivo qué HTML devuelve una página del sitio.
// Útil cuando el sitio cambia de estructura y hay que ajustar los
// selectores/regex del provider. Ejemplo de uso:
//   /debug/page?url=https://www.librefutbol2.com/directv-sports-en-vivo-online.php
// Devuelve un resumen (dónde aparecen <iframe>, "playlist.php", "player",
// "options") en vez del HTML completo, para que sea fácil de leer.
// ==========================================
app.get('/debug/page', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Falta ?url=https://www.librefutbol2.com/algun-canal.php');

  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const { getHtml } = require('./http');
    const html = await getHtml(url, { headers: { Referer: librefutbol.MAIN_URL } });

    const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]);
    const playlistMentions = [...html.matchAll(/[^\n]{0,60}playlist\.php[^\n]{0,60}/gi)].map((m) => m[0]);
    const optionMentions = [...html.matchAll(/[^\n]{0,80}(options-left|class="option"|div\.option)[^\n]{0,80}/gi)].map((m) => m[0]);
    const playerMentions = [...html.matchAll(/[^\n]{0,60}player[^\n]{0,60}/gi)].slice(0, 15).map((m) => m[0]);

    res.send(
      `URL: ${url}\n` +
      `Largo del HTML: ${html.length} caracteres\n\n` +
      `--- <iframe> encontrados (${iframes.length}) ---\n${iframes.join('\n') || '(ninguno)'}\n\n` +
      `--- Menciones de "playlist.php" (${playlistMentions.length}) ---\n${playlistMentions.join('\n') || '(ninguna)'}\n\n` +
      `--- Menciones de "options-left" / class="option" (${optionMentions.length}) ---\n${optionMentions.join('\n') || '(ninguna)'}\n\n` +
      `--- Primeras menciones de "player" (${playerMentions.length}) ---\n${playerMentions.join('\n') || '(ninguna)'}\n\n` +
      `--- HTML completo (primeros 6000 caracteres) ---\n${html.slice(0, 6000)}`
    );
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ==========================================
// DEBUG: probar una URL de playlist (.m3u8/.php) real contra varias
// combinaciones de Origin/Referer para descubrir cuál acepta el CDN.
// Uso: /debug/testplaylist?url=<url del playlist.php con su ?sig=...>
// ==========================================
// ==========================================
// DEBUG: confirmar que Chromium al menos arranca en este entorno,
// independiente de toda la complejidad del sitio (mismo chequeo que
// usaste en el addon de PelisPedia).
// ==========================================
app.get('/debug/browsercheck', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    return res.status(500).send(`El paquete "puppeteer" no está instalado: ${e.message}`);
  }

  try {
    const t0 = Date.now();
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    await browser.close();

    res.send(
      `OK -- Chromium arrancó y navegó en ${Date.now() - t0}ms.\n` +
      `executablePath usado: ${launchOpts.executablePath || '(el que trae puppeteer por defecto)'}\n` +
      `Título de prueba (example.com): ${title}`
    );
  } catch (e) {
    res.status(500).send(`ERROR al arrancar/usar Puppeteer: ${e.message}\n\nStack:\n${e.stack}`);
  }
});

app.get('/debug/testplaylist', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Falta ?url=<playlist.php con su sig>');

  const fetch = require('node-fetch');
  const { DEFAULT_HEADERS } = require('./http');

  let origin;
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return res.status(400).send('URL inválida');
  }

  const attempts = [
    { label: 'sin Origin/Referer (solo UA)', headers: {} },
    { label: 'Origin/Referer = embed.ksdjugfssddeports.com (el que usamos hoy)', headers: { Origin: 'https://embed.ksdjugfssddeports.com', Referer: 'https://embed.ksdjugfssddeports.com/' } },
    { label: 'Origin/Referer = www.librefutbol2.com', headers: { Origin: 'https://www.librefutbol2.com', Referer: 'https://www.librefutbol2.com/' } },
    { label: 'Referer = la propia URL del playlist (sin Origin)', headers: { Referer: url } },
    { label: 'Origin/Referer = origin del propio CDN (deportes.ksdjugfssddeports.com)', headers: { Origin: origin, Referer: `${origin}/` } },
  ];

  const results = [];
  for (const attempt of attempts) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_HEADERS['User-Agent'], ...attempt.headers },
      });
      let snippet = '';
      try {
        snippet = (await r.text()).slice(0, 150).replace(/\s+/g, ' ');
      } catch (e) { /* ignore */ }
      results.push(`${r.status === 200 ? '✅' : '❌'} [${r.status}] ${attempt.label} -> headers: ${JSON.stringify(attempt.headers)}\n     body: ${snippet}`);
    } catch (e) {
      results.push(`❌ [ERROR] ${attempt.label}: ${e.message}`);
    }
  }

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(`URL probada: ${url}\n\n${results.join('\n\n')}`);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`Addon corriendo en ${base}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn('AVISO: falta PUBLIC_URL. En Railway hay que configurarla.');
  }
});
