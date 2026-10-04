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

// ==========================================
// RESOLUCIÓN POR CANAL -- UNA PÁGINA NUEVA POR SERVIDOR
// ==========================================
// Lo que se aprendió con los logs reales:
//  1) El sitio sirve HTML DISTINTO según el cliente. A Chromium le da
//     botones <button class="option" data-src=".../live2/core.php?canal=..">;
//     al fetch plano le puede dar enlaces a otras rutas (/envivo2/...) que no
//     resuelven nada. Por eso la LISTA DE SERVIDORES se lee del DOM que ve
//     Chromium, no del HTML estático.
//  2) La página del canal trae un token inline (window['ZpQw9X...']) que el
//     iframe core.php (mismo origen) lee del padre para firmar. Una página
//     "cascarón" sin ese token no resuelve nada, y reusar la MISMA página
//     para un segundo servidor tampoco (parece de un solo uso). Por eso cada
//     servidor se resuelve en una página nueva.
//  3) Varios iframes a la vez en una página dieron 0/3 siempre.
// Las páginas respetan el límite de concurrencia (PUPPETEER_MAX_CONCURRENT_PAGES,
// default 1 = de a una). Con más RAM, subirlo resuelve los servidores en
// paralelo (cada uno en su propia página).
// ==========================================

function samePath(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.pathname === y.pathname && x.search === y.search;
  } catch (e) {
    return false;
  }
}

// ¿El pedido a playlist.php salió del iframe del servidor que estamos
// probando? (una página puede traer su propio iframe autocargado con otro
// servidor; ese no debe contarse). Si ningún frame de la cadena es un
// core.php, se acepta (no hay forma de distinguir).
function requestFromTarget(req, targetUrl) {
  let sawCore = false;
  for (let f = req.frame(); f; f = f.parentFrame()) {
    const u = f.url();
    if (!u || !/core\.php/i.test(u)) continue;
    sawCore = true;
    if (samePath(u, targetUrl)) return true;
  }
  return !sawCore;
}

/**
 * Abre UNA página nueva del canal (la real, con su token) y:
 *  - sin `target`: lee la lista de servidores del DOM y resuelve el primero;
 *  - con `target`: resuelve ese servidor.
 * Devuelve { candidates, result, skipped }.
 */
async function runChannelPage(channelUrl, { target = null, fallback = [], deadline, perCandidateMs = 12000 }) {
  const out = { candidates: null, result: null, skipped: false };
  if (!puppeteer) {
    console.log('[librefutbol/browser] puppeteer no está disponible (no instalado o falló el require)');
    out.skipped = true;
    return out;
  }

  const gotSlot = await acquirePageSlot(Math.max(0, deadline - Date.now() - 4000));
  if (!gotSlot) {
    console.log('[librefutbol/browser] sin cupo de página a tiempo (cola llena)');
    out.skipped = true;
    return out;
  }

  let page = null;
  try {
    const browser = await getBrowser();
    _pagesServed++;
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let current = target; // servidor que se está probando ahora
    let captured = null;

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return safeAbort(req);
      if (AD_NOISE.some((needle) => url.includes(needle))) return safeAbort(req);

      if (current && !captured && /playlist\.php/i.test(url) && requestFromTarget(req, current.url)) {
        const referer = req.headers()['referer'] || current.url;
        let origin;
        try {
          origin = new URL(referer).origin;
        } catch (e) {
          origin = undefined;
        }
        captured = { url, headers: { Referer: referer, Origin: origin, 'User-Agent': UA } };
      }
      safeContinue(req);
    });

    const t0 = Date.now();
    const navTimeout = Math.min(15000, Math.max(3000, deadline - Date.now() - 3000));
    try {
      await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    } catch (e) {
      console.log(`[librefutbol/browser] goto lento/falló (${e.message}), sigo igual`);
    }
    const tLoad = Date.now() - t0;

    // --- Descubrir servidores desde el DOM (solo en la primera página) ---
    if (!target) {
      try {
        await page.waitForFunction(
          () => document.querySelector('button.option[data-src], [data-src*="core.php"], a[href*="core.php"]'),
          { timeout: Math.max(1000, Math.min(6000, deadline - Date.now() - 1000)) }
        );
      } catch (e) {
        /* leemos lo que haya */
      }
      const found = await page
        .evaluate(() => {
          const list = [];
          const seen = new Set();
          const add = (raw, label) => {
            if (!raw || !/core\.php/i.test(raw)) return;
            let abs;
            try {
              abs = new URL(raw, location.href).href;
            } catch (e) {
              return;
            }
            if (seen.has(abs)) return;
            seen.add(abs);
            list.push({ url: abs, name: (label || '').replace(/\s+/g, ' ').trim() });
          };
          document
            .querySelectorAll('button.option[data-src], .options-left [data-src]')
            .forEach((el) => add(el.getAttribute('data-src'), el.textContent || el.getAttribute('data-label')));
          if (list.length === 0) {
            document
              .querySelectorAll('a.option[href], .options-left a[href], a[target="player"][href]')
              .forEach((el) => add(el.getAttribute('href'), el.textContent));
          }
          if (list.length === 0) {
            document.querySelectorAll('[data-src],[data-url],[data-link]').forEach((el) =>
              add(el.getAttribute('data-src') || el.getAttribute('data-url') || el.getAttribute('data-link'), el.textContent)
            );
          }
          if (list.length === 0) {
            document.querySelectorAll('iframe[src*="core.php"]').forEach((f) => add(f.getAttribute('src'), 'Opción 1'));
          }
          return list;
        })
        .catch(() => []);

      out.candidates = (found.length > 0 ? found : fallback).map((c, i) => ({
        url: c.url,
        name: c.name || `Servidor ${i + 1}`,
      }));
      console.log(
        `[librefutbol/browser] página lista en ${tLoad}ms, servidores en el DOM: ${found.length}` +
          (found.length === 0 ? ` (uso ${fallback.length} del HTML estático)` : '')
      );
      current = out.candidates[0] || null;
      if (!current) return out;
    } else {
      console.log(`[librefutbol/browser] página lista en ${tLoad}ms para "${target.name}"`);
    }

    // --- Apuntar el iframe del player al servidor elegido ---
    try {
      await page.evaluate((src) => {
        let frame = document.querySelector('iframe#playerFrame, iframe#player-frame, iframe[name="player"]');
        if (!frame) {
          frame = document.createElement('iframe');
          frame.id = 'playerFrame';
          frame.style.cssText = 'width:640px;height:360px;border:0';
          document.body.appendChild(frame);
        }
        frame.src = src;
      }, current.url);
    } catch (e) {
      console.log(`[librefutbol/browser] no se pudo setear el iframe para ${current.name}: ${e.message}`);
      return out;
    }

    const tWait = Date.now();
    const limit = Math.min(perCandidateMs, Math.max(0, deadline - Date.now() - 1000));
    while (!captured && Date.now() - tWait < limit && !page.isClosed()) {
      await sleep(150);
    }

    if (!captured) {
      console.log(`[librefutbol/browser] ${current.name}: sin playlist.php en ${Date.now() - tWait}ms`);
      return out;
    }
    console.log(`[librefutbol/browser] ${current.name}: playlist.php capturado en ${Date.now() - tWait}ms`);

    try {
      const cdnOrigin = new URL(captured.url).origin;
      const cookies = await page.cookies(cdnOrigin, channelUrl);
      if (cookies.length > 0) {
        captured.headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {
      /* sin cookies extra, seguimos igual */
    }
    out.result = { candidate: current, url: captured.url, headers: captured.headers };
    return out;
  } catch (e) {
    console.log(`[librefutbol/browser] error en ${channelUrl}: ${e.message}`);
    return out;
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
}

/**
 * Resuelve todos los servidores de un canal. `fallback` = candidatos del
 * HTML estático, solo se usan si el DOM de Chromium no trae ninguno.
 * Devuelve { results: [{candidate,url,headers}], total }.
 */
async function resolveChannelViaBrowser(channelUrl, fallback, { deadline, perCandidateMs = 12000 } = {}) {
  if (!deadline) deadline = Date.now() + 45000;

  const first = await runChannelPage(channelUrl, { fallback, deadline, perCandidateMs });
  const list = first.candidates && first.candidates.length > 0 ? first.candidates : fallback || [];
  const results = [];
  if (first.result) results.push(first.result);
  if (first.skipped || list.length === 0) return { results, total: list.length };

  // El resto de servidores: una página nueva cada uno.
  const rest = list.slice(1);
  if (MAX_CONCURRENT_PAGES > 1) {
    // Con RAM de sobra: en paralelo (el límite de páginas hace de semáforo).
    const settled = await Promise.all(
      rest.map((cand) => runChannelPage(channelUrl, { target: cand, deadline, perCandidateMs }))
    );
    for (const r of settled) if (r.result) results.push(r.result);
  } else {
    // De a una. Si los 2 primeros servidores fallan y no hay NINGÚN
    // resultado, el canal casi seguro está caído: no se gastan más páginas
    // (~15s cada una) en probar el resto.
    let failures = first.result ? 0 : 1;
    for (const cand of rest) {
      if (results.length === 0 && failures >= 2) {
        console.log('[librefutbol/browser] 2 servidores sin resultado y ninguno resuelto: canal caído, se corta');
        return { results, total: list.length };
      }
      if (deadline - Date.now() < 6000) break;
      const r = await runChannelPage(channelUrl, { target: cand, deadline, perCandidateMs });
      if (r.result) results.push(r.result);
      else failures++;
    }
  }

  // Un reintento secuencial para los que fallaron, si queda tiempo (y si el
  // canal dio algo: uno que no dio nada ya se descartó arriba).
  const missing = results.length > 0 ? list.filter((c) => !results.some((r) => r.candidate.url === c.url)) : [];
  for (const cand of missing) {
    if (deadline - Date.now() < 12000) break;
    console.log(`[librefutbol/browser] reintentando "${cand.name}"`);
    const r = await runChannelPage(channelUrl, { target: cand, deadline, perCandidateMs });
    if (r.result) results.push(r.result);
  }

  results.sort((x, y) => list.findIndex((c) => c.url === x.candidate.url) - list.findIndex((c) => c.url === y.candidate.url));
  return { results, total: list.length };
}

/**
 * Plan B para canales cuyo HTML estático no trae los botones de servidor
 * (ej. se arman con JS): carga la página real en Chromium y lee los
 * candidatos del DOM ya renderizado.
 */
async function collectCandidatesViaBrowser(channelUrl, { deadline } = {}) {
  if (!puppeteer) return [];
  if (!deadline) deadline = Date.now() + 20000;
  const gotSlot = await acquirePageSlot(Math.max(0, deadline - Date.now() - 4000));
  if (!gotSlot) return [];

  let page = null;
  try {
    const browser = await getBrowser();
    _pagesServed++;
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return safeAbort(req);
      if (AD_NOISE.some((needle) => url.includes(needle))) return safeAbort(req);
      safeContinue(req);
    });

    const t0 = Date.now();
    try {
      await page.goto(channelUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(15000, Math.max(3000, deadline - Date.now() - 3000)),
      });
    } catch (e) {
      console.log(`[librefutbol/browser] goto (candidatos) lento/falló (${e.message}), sigo igual`);
    }
    try {
      await page.waitForFunction(
        () => document.querySelector('[data-src], button.option, .options-left, iframe[src*="core.php"]'),
        { timeout: Math.max(1000, Math.min(8000, deadline - Date.now() - 1000)) }
      );
    } catch (e) {
      /* seguimos y leemos lo que haya */
    }

    const found = await page
      .evaluate(() => {
        const out = [];
        const seen = new Set();
        const add = (raw, label) => {
          if (!raw || /^(javascript:|#|about:)/i.test(raw)) return;
          let abs;
          try {
            abs = new URL(raw, location.href).href;
          } catch (e) {
            return;
          }
          if (seen.has(abs)) return;
          seen.add(abs);
          out.push({ url: abs, name: (label || '').trim() });
        };
        document.querySelectorAll('[data-src],[data-url],[data-link],[data-iframe],[data-embed]').forEach((el) => {
          const raw =
            el.getAttribute('data-src') ||
            el.getAttribute('data-url') ||
            el.getAttribute('data-link') ||
            el.getAttribute('data-iframe') ||
            el.getAttribute('data-embed');
          if (/core\.php/i.test(raw || '')) {
            add(raw, el.textContent || el.getAttribute('data-label'));
          }
        });
        document.querySelectorAll('iframe[src*="core.php"]').forEach((f) => add(f.getAttribute('src'), ''));
        return out;
      })
      .catch(() => []);

    console.log(`[librefutbol/browser] candidatos vía navegador: ${found.length} en ${Date.now() - t0}ms`);
    return found;
  } catch (e) {
    console.log(`[librefutbol/browser] error buscando candidatos de ${channelUrl}: ${e.message}`);
    return [];
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
}

module.exports = {
  resolveChannelViaBrowser,
  collectCandidatesViaBrowser,
  warmBrowser,
  getBrowser,
};
