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

// Página "cascarón": en vez de bajar la página real del canal (con toda su
// publicidad, ~10s en un server chico), se intercepta SOLO esa navegación y
// se responde un HTML vacío. La URL de la página sigue siendo la del canal,
// así que el Referer/Origin que ven los iframes de servidor es el mismo que
// si hubiera cargado la real -- pero sin pagar la carga. Si con el cascarón
// no se resuelve ningún servidor, se reintenta con la página real.
// LIBREFUTBOL_STUB_PARENT=0 lo desactiva.
const STUB_PARENT = process.env.LIBREFUTBOL_STUB_PARENT !== '0';
const STUB_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

function normHref(u) {
  try {
    return new URL(u).href;
  } catch (e) {
    return u || '';
  }
}
function canalOf(u) {
  try {
    return new URL(u).searchParams.get('canal');
  } catch (e) {
    return null;
  }
}

/**
 * Resuelve el playlist.php de VARIOS servidores de un mismo canal con UNA
 * sola página de Chromium:
 *   1) Fase paralela: un iframe por servidor, todos a la vez (cada
 *      playlist.php capturado se atribuye al servidor según de qué iframe
 *      salió el pedido). Tarda lo que tarda el más lento, no la suma.
 *   2) Fase secuencial: los que no se resolvieron en paralelo se reintentan
 *      de a uno, por si el sitio no tolera varios a la vez.
 * Devuelve [{ candidate, url, headers }] (puede ser parcial o vacío).
 */
async function resolvePlaylistsViaBrowser(
  channelUrl,
  candidates,
  { deadline, perCandidateMs = 10000, parallelMs = 12000 } = {}
) {
  const results = [];
  if (!puppeteer) {
    console.log('[librefutbol/browser] puppeteer no está disponible (no instalado o falló el require)');
    return results;
  }
  if (!deadline) deadline = Date.now() + 30000;

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

    const state = { stub: false, stubbed: false, active: [], seen: new Set(), warnedUnattributed: false };

    function pickEntry(req) {
      const act = state.active.filter((e) => !e.result);
      if (act.length === 0) return null;
      if (act.length === 1) return act[0];
      for (let f = req.frame(); f; f = f.parentFrame()) {
        const fu = f.url();
        if (!fu) continue;
        const nu = normHref(fu);
        const fc = canalOf(fu);
        const hit = act.find((e) => e.key === nu || (e.canal && fc && e.canal === fc));
        if (hit) return hit;
      }
      return null;
    }

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();

      if (state.stub && !state.stubbed && type === 'document' && req.frame() === page.mainFrame()) {
        state.stubbed = true;
        try {
          req
            .respond({ status: 200, contentType: 'text/html; charset=utf-8', body: STUB_HTML })
            .catch(() => {});
        } catch (e) {
          /* noop */
        }
        return;
      }

      if (type === 'image' || type === 'font' || type === 'media') return safeAbort(req);
      if (AD_NOISE.some((needle) => url.includes(needle))) return safeAbort(req);

      if (/playlist\.php/i.test(url) && !state.seen.has(url)) {
        const entry = pickEntry(req);
        if (entry) {
          const referer = req.headers()['referer'] || entry.candidate.url;
          let origin;
          try {
            origin = new URL(referer).origin;
          } catch (e) {
            origin = undefined;
          }
          state.seen.add(url);
          entry.result = { url, headers: { Referer: referer, Origin: origin, 'User-Agent': UA } };
          entry.at = Date.now();
        } else if (!state.warnedUnattributed && state.active.length > 0) {
          state.warnedUnattributed = true;
          console.log('[librefutbol/browser] playlist.php visto pero no se pudo atribuir a un servidor');
        }
      }
      safeContinue(req);
    });

    const setSrc = (idx, src) =>
      page
        .evaluate(
          (i, u) => {
            const f = document.getElementById('srvFrame' + i);
            if (f) f.src = u;
          },
          idx,
          src
        )
        .catch(() => {});

    const waitFor = async (entries, limitMs) => {
      const t0 = Date.now();
      while (entries.some((e) => !e.result) && Date.now() - t0 < limitMs && !page.isClosed()) {
        await sleep(120);
      }
    };

    const withCookies = async (entry) => {
      try {
        const cdnOrigin = new URL(entry.result.url).origin;
        const cookies = await page.cookies(cdnOrigin, channelUrl);
        if (cookies.length > 0) {
          entry.result.headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      } catch (e) {
        /* sin cookies extra, seguimos igual */
      }
    };

    const modes = STUB_PARENT ? ['stub', 'real'] : ['real'];
    let pending = candidates.slice();

    for (const mode of modes) {
      if (pending.length === 0 || page.isClosed()) break;
      if (deadline - Date.now() < 4000) {
        console.log('[librefutbol/browser] se acabó el presupuesto de tiempo antes de intentar');
        break;
      }

      state.stub = mode === 'stub';
      state.stubbed = false;
      const tMode = Date.now();
      const navTimeout = Math.min(15000, Math.max(3000, deadline - Date.now() - 3000));
      try {
        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      } catch (e) {
        console.log(`[librefutbol/browser] goto (${mode}) lento/falló (${e.message}), sigo igual`);
      }
      console.log(`[librefutbol/browser] página (${mode}) lista en ${Date.now() - tMode}ms`);

      // Un iframe por servidor. Si la página real trae su iframe de player,
      // se clona (mismos atributos: allow, sandbox, etc.).
      try {
        await page.evaluate((n) => {
          const orig = document.querySelector('iframe#playerFrame, iframe#player-frame');
          const parent = (orig && orig.parentNode) || document.body;
          for (let i = 0; i < n; i++) {
            const f = orig ? orig.cloneNode(false) : document.createElement('iframe');
            f.removeAttribute('src');
            f.id = 'srvFrame' + i;
            f.name = 'srv' + i;
            if (!orig) f.style.cssText = 'width:640px;height:360px;border:0';
            parent.appendChild(f);
          }
        }, candidates.length);
      } catch (e) {
        console.log(`[librefutbol/browser] no se pudieron crear los iframes (${mode}): ${e.message}`);
        continue;
      }

      const entries = pending.map((c) => ({
        candidate: c,
        idx: candidates.indexOf(c),
        key: normHref(c.url),
        canal: canalOf(c.url),
        result: null,
        at: 0,
      }));

      // ---- Fase paralela ----
      if (entries.length > 1) {
        const tPar = Date.now();
        state.active = entries;
        await Promise.all(entries.map((e) => setSrc(e.idx, e.candidate.url)));
        await waitFor(entries, Math.min(parallelMs, deadline - Date.now() - 2500));
        state.active = [];
        console.log(
          `[librefutbol/browser] paralelo (${mode}): ${entries.filter((e) => e.result).length}/${entries.length} en ${Date.now() - tPar}ms`
        );
        await Promise.all(entries.map((e) => setSrc(e.idx, 'about:blank')));
      }

      // ---- Fase secuencial para los que faltan ----
      for (const e of entries) {
        if (e.result || page.isClosed()) continue;
        const remaining = deadline - Date.now();
        if (remaining < 2500) {
          console.log('[librefutbol/browser] se acabó el presupuesto de tiempo, no se prueban más servidores');
          break;
        }
        const t0 = Date.now();
        state.active = [e];
        await setSrc(e.idx, e.candidate.url);
        await waitFor([e], Math.min(perCandidateMs, remaining));
        state.active = [];
        await setSrc(e.idx, 'about:blank');
        if (e.result) {
          console.log(`[librefutbol/browser] ${e.candidate.name}: capturado en ${Date.now() - t0}ms (secuencial)`);
        } else {
          console.log(`[librefutbol/browser] ${e.candidate.name}: sin playlist.php en ${Date.now() - t0}ms`);
        }
      }

      for (const e of entries) {
        if (!e.result) continue;
        await withCookies(e);
        results.push({ candidate: e.candidate, url: e.result.url, headers: e.result.headers });
      }
      pending = pending.filter((c) => !results.some((r) => r.candidate === c));

      if (results.length > 0) break; // con algo resuelto no se repite en modo "real"
      console.log(`[librefutbol/browser] modo ${mode}: 0 servidores resueltos`);
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
  // Mismo orden que los botones del sitio.
  results.sort((x, y) => candidates.indexOf(x.candidate) - candidates.indexOf(y.candidate));
  return results;
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
          if (el.tagName === 'IFRAME' || /core\.php|\.php|^https?:/i.test(raw || '')) {
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

// Compatibilidad con la firma vieja (un solo candidato).
async function resolvePlaylistViaBrowser(channelUrl, candidateEmbedUrl, timeoutMs = 25000) {
  const r = await resolvePlaylistsViaBrowser(
    channelUrl,
    [{ url: candidateEmbedUrl, name: 'Servidor' }],
    { deadline: Date.now() + timeoutMs + 5000, perCandidateMs: timeoutMs }
  );
  return r[0] ? { url: r[0].url, headers: r[0].headers } : null;
}

module.exports = {
  resolvePlaylistsViaBrowser,
  resolvePlaylistViaBrowser,
  collectCandidatesViaBrowser,
  warmBrowser,
  getBrowser,
};
