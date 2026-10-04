const { DEFAULT_HEADERS } = require('../http');

// ==========================================
// POR QUÉ HACE FALTA UN NAVEGADOR ACÁ
// ==========================================
// El sig que aparece escrito en el HTML estático de core.php es un señuelo
// -- el sitio devuelve 403 para ese sig sin importar qué Origin/Referer le
// mandemos. El sig que realmente funciona lo genera un script ofuscado del
// lado del navegador que dispara una llamada a stream.php?...&sig=... ANTES
// de que playlist.php acepte el pedido. Hace falta ejecutar el JS real.
// ==========================================

let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  /* opcional -- si no está instalado, este resolver no funciona */
}

const UA = DEFAULT_HEADERS['User-Agent'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==========================================
// BROWSER ÚNICO Y COMPARTIDO
// ==========================================
// Antes: dos pedidos simultáneos con el browser todavía sin lanzar veían
// ambos "null" y lanzaban DOS Chromium (carrera) -> RAM de más, a veces
// crash, y resultado "0 streams". Ahora hay una sola promesa de lanzamiento
// que todos comparten, y si Chromium muere ('disconnected') se relanza solo
// en el próximo pedido.
let _browser = null;
let _browserPromise = null;
let _pagesServed = 0;

// Chromium de larga vida va acumulando memoria. Cuando no hay nadie usándolo
// y ya atendió RECYCLE_AFTER_PAGES páginas, se cierra y el próximo pedido
// levanta uno limpio.
const RECYCLE_AFTER_PAGES = parseInt(process.env.PUPPETEER_RECYCLE_AFTER_PAGES || '40', 10);

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer no está instalado');
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserPromise) return _browserPromise;

  _browserPromise = (async () => {
    try {
      const launchOpts = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--mute-audio',
          '--no-first-run',
        ],
      };
      // Chromium instalado por apt (ver Dockerfile).
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }
      const t0 = Date.now();
      const b = await puppeteer.launch(launchOpts);
      b.on('disconnected', () => {
        console.log('[librefutbol/browser] Chromium se desconectó/cerró');
        if (_browser === b) _browser = null;
      });
      _browser = b;
      _pagesServed = 0;
      console.log(`[librefutbol/browser] Chromium listo en ${Date.now() - t0}ms`);
      return b;
    } finally {
      _browserPromise = null;
    }
  })();
  return _browserPromise;
}

// Lanza Chromium en segundo plano al arrancar el addon, así el primer
// pedido real no paga el arranque en frío (varios segundos).
async function warmBrowser() {
  try {
    await getBrowser();
  } catch (e) {
    console.log(`[librefutbol/browser] no se pudo precalentar: ${e.message}`);
  }
}

// ==========================================
// LÍMITE DE CONCURRENCIA (RAM limitada en Render free)
// ==========================================
const MAX_CONCURRENT_PAGES = Math.max(1, parseInt(process.env.PUPPETEER_MAX_CONCURRENT_PAGES || '1', 10));
let _activePages = 0;
const _pageQueue = [];

// Devuelve true si consiguió cupo, false si esperó más de maxWaitMs (para
// no quedarse en cola más tiempo del que el pedido tiene de presupuesto).
function acquirePageSlot(maxWaitMs) {
  if (_activePages < MAX_CONCURRENT_PAGES) {
    _activePages++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { resolve: null, timer: null };
    entry.resolve = (ok) => {
      clearTimeout(entry.timer);
      resolve(ok);
    };
    entry.timer = setTimeout(() => {
      const i = _pageQueue.indexOf(entry);
      if (i >= 0) _pageQueue.splice(i, 1);
      resolve(false);
    }, Math.max(0, maxWaitMs));
    _pageQueue.push(entry);
  });
}

function releasePageSlot() {
  if (_pageQueue.length > 0) {
    _pageQueue.shift().resolve(true); // el que esperaba toma el cupo directo
    return;
  }
  _activePages--;
  if (_activePages === 0 && _browser && _pagesServed >= RECYCLE_AFTER_PAGES) {
    const old = _browser;
    _browser = null;
    console.log(`[librefutbol/browser] reciclando Chromium tras ${_pagesServed} páginas`);
    old.close().catch(() => {});
  }
}

const AD_NOISE = [
  'sharethis', 'doubleclick', 'adexchangerapid', 'usrpubtrk', 'rlcdn',
  'crwdcntrl', 'tapad', 'adsrvr', 'eyeota', 'liadm', 'demdex', 'lijit',
  'agkn', 'dtscout', 'exelator', 'zeotap', 'onaudience', 'rfihub',
  'pubmatic', 'openx', 'affec.tv', 'rezync', 'thrtle', 'dtscdn',
  'stackadapt', 'tynt', 'mrktmtrcs', 'intentiq', 'rqtrk', 'amazon-adsystem',
];

// abort()/continue() devuelven promesas que RECHAZAN si la página ya se
// cerró; sin este catch eso era un "unhandledRejection" que en Node 20
// tira abajo todo el proceso (Render lo reinicia -> 0 streams).
function safeAbort(req) {
  try {
    req.abort().catch(() => {});
  } catch (e) {
    /* noop */
  }
}
function safeContinue(req) {
  try {
    req.continue().catch(() => {});
  } catch (e) {
    /* noop */
  }
}

/**
 * Resuelve el playlist.php de VARIOS servidores de un mismo canal usando UNA
 * sola página de Chromium: carga la página del canal una vez y luego va
 * cambiando el src del iframe de servidor en servidor. Antes se abría una
 * página nueva (y se recargaba toda la página del canal con su publicidad)
 * por cada servidor, uno tras otro -- esa era la mayor parte de la lentitud.
 *
 * Devuelve [{ candidate, url, headers }] con los que se pudieron resolver
 * (puede ser parcial o vacío). Respeta `deadline` (timestamp ms): no empieza
 * un servidor nuevo si ya no queda tiempo.
 */
async function resolvePlaylistsViaBrowser(channelUrl, candidates, { deadline, perCandidateMs = 10000 } = {}) {
  const results = [];
  if (!puppeteer) {
    console.log('[librefutbol/browser] puppeteer no está disponible (no instalado o falló el require)');
    return results;
  }
  if (!deadline) deadline = Date.now() + 20000;

  const gotSlot = await acquirePageSlot(Math.max(0, deadline - Date.now() - 5000));
  if (!gotSlot) {
    console.log('[librefutbol/browser] sin cupo de página a tiempo (cola llena), se abandona este pedido');
    return results;
  }

  let page = null;
  try {
    const browser = await getBrowser();
    _pagesServed++;
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    // "current" = el servidor que estamos probando ahora. Solo se acepta un
    // playlist.php mientras haya uno en curso, así no se le asigna a un
    // servidor el pedido tardío de otro.
    let current = null;
    const seenUrls = new Set();

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();

      if (type === 'image' || type === 'font' || type === 'media') return safeAbort(req);
      if (AD_NOISE.some((needle) => url.includes(needle))) return safeAbort(req);

      if (current && !current.result && !seenUrls.has(url) && /playlist\.php/i.test(url)) {
        const referer = req.headers()['referer'] || current.candidate.url;
        let origin;
        try {
          origin = new URL(referer).origin;
        } catch (e) {
          origin = undefined;
        }
        seenUrls.add(url);
        current.result = {
          url,
          headers: { Referer: referer, Origin: origin, 'User-Agent': UA },
        };
      }
      safeContinue(req);
    });

    const navTimeout = Math.min(15000, Math.max(3000, deadline - Date.now() - 2000));
    try {
      await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    } catch (e) {
      // Antes un timeout acá abortaba TODO (-> 0 streams). Con la página
      // medio cargada muchas veces el iframe ya existe, así que seguimos.
      console.log(`[librefutbol/browser] goto lento/falló (${e.message}), sigo igual`);
    }
    try {
      await page.waitForSelector('iframe#playerFrame, iframe#player-frame', { timeout: 4000 });
    } catch (e) {
      /* si no está, más abajo se crea uno */
    }

    for (const candidate of candidates) {
      if (page.isClosed()) break;
      const remaining = deadline - Date.now();
      if (remaining < 2500) {
        console.log('[librefutbol/browser] se acabó el presupuesto de tiempo, no se prueban más servidores');
        break;
      }

      const entry = { candidate, result: null };
      current = entry;
      const t0 = Date.now();

      try {
        await page.evaluate((src) => {
          let frame = document.querySelector('iframe#playerFrame, iframe#player-frame');
          if (!frame) {
            frame = document.createElement('iframe');
            frame.id = 'playerFrame';
            frame.style.cssText = 'width:640px;height:360px;border:0';
            document.body.appendChild(frame);
          }
          frame.src = src;
        }, candidate.url);
      } catch (e) {
        console.log(`[librefutbol/browser] no se pudo setear el iframe para ${candidate.name}: ${e.message}`);
        current = null;
        continue;
      }

      const limit = Math.min(perCandidateMs, remaining);
      while (!entry.result && Date.now() - t0 < limit && !page.isClosed()) {
        await sleep(150);
      }
      current = null;

      if (!entry.result) {
        console.log(`[librefutbol/browser] ${candidate.name}: sin playlist.php en ${Date.now() - t0}ms`);
        continue;
      }

      const resolved = entry.result;
      try {
        const cdnOrigin = new URL(resolved.url).origin;
        const cookies = await page.cookies(cdnOrigin, channelUrl);
        if (cookies.length > 0) {
          resolved.headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      } catch (e) {
        /* sin cookies extra, seguimos igual */
      }

      console.log(`[librefutbol/browser] ${candidate.name}: playlist.php capturado en ${Date.now() - t0}ms`);
      results.push({ candidate, url: resolved.url, headers: resolved.headers });
    }
  } catch (e) {
    console.log(`[librefutbol/browser] error resolviendo ${channelUrl}: ${e.message}`);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        /* ignore */
      }
    }
    releasePageSlot();
  }
  return results;
}

// Compatibilidad con la firma vieja (un solo candidato).
async function resolvePlaylistViaBrowser(channelUrl, candidateEmbedUrl, timeoutMs = 25000) {
  const r = await resolvePlaylistsViaBrowser(
    channelUrl,
    [{ url: candidateEmbedUrl, name: 'Servidor' }],
    { deadline: Date.now() + timeoutMs + 5000, perCandidateMs: timeoutMs }
  );
  return r[0] ? { url: r[0].url, headers: r[0].headers } : null;
}

module.exports = { resolvePlaylistsViaBrowser, resolvePlaylistViaBrowser, warmBrowser, getBrowser };
