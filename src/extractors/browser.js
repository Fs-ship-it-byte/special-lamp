const { DEFAULT_HEADERS } = require('../http');

// ==========================================
// POR QUÉ HACE FALTA UN NAVEGADOR ACÁ
// ==========================================
// El sig que aparece escrito en el HTML estático de core.php (el que
// nuestro regex encuentra) es un señuelo -- el sitio devuelve 403 para
// ese sig sin importar qué Origin/Referer le mandemos. El sig que
// realmente funciona lo genera un script ofuscado del lado del navegador
// (fingerprinting) que dispara una llamada a stream.php?...&sig=... ANTES
// de que playlist.php acepte el pedido. No hay forma de reproducir esa
// firma con regex/fetch plano: hace falta ejecutar el JS real del sitio.
// ==========================================

let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  /* opcional -- si no está instalado, este resolver no funciona */
}

let _browserInstance = null;
async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer no está instalado');
  if (_browserInstance && _browserInstance.isConnected()) return _browserInstance;

  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  // Usamos el Chromium instalado por apt en vez del que puppeteer bajaría
  // solo -- ver el comentario en el Dockerfile.
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  console.log(`[librefutbol/browser] lanzando Chromium (executablePath=${launchOpts.executablePath || '(bundled)'})`);
  _browserInstance = await puppeteer.launch(launchOpts);
  return _browserInstance;
}

// Navega a la página del canal, fuerza el iframe#playerFrame a apuntar al
// candidato elegido (equivalente a hacer click en su botón de servidor,
// sin depender de encontrar el botón exacto por texto/posición), y
// escucha la red hasta ver un pedido a playlist.php -- devuelve esa URL
// junto con los headers y cookies con los que el propio sitio la pidió.
async function resolvePlaylistViaBrowser(channelUrl, candidateEmbedUrl, timeoutMs = 25000) {
  if (!puppeteer) {
    console.log('[librefutbol/browser] puppeteer no está disponible (no instalado o falló el require)');
    return null;
  }

  console.log(`[librefutbol/browser] resolviendo ${candidateEmbedUrl} vía navegador...`);

  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);
    await page.setRequestInterception(true);

    let resolved = null;

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();

      // Aliviana la carga: no hace falta bajar imágenes, fuentes ni la
      // maraña de scripts de publicidad/tracking que vimos en el log real
      // (adexchangerapid, sharethis, doubleclick, etc.) -- eso solo
      // consume tiempo y banda sin aportar nada a lo que buscamos.
      const AD_NOISE = [
        'sharethis', 'doubleclick', 'adexchangerapid', 'usrpubtrk', 'rlcdn',
        'crwdcntrl', 'tapad', 'adsrvr', 'eyeota', 'liadm', 'demdex', 'lijit',
        'agkn', 'dtscout', 'exelator', 'zeotap', 'onaudience', 'rfihub',
        'pubmatic', 'openx', 'affec.tv', 'rezync', 'thrtle', 'dtscdn',
        'stackadapt', 'tynt', 'mrktmtrcs', 'intentiq', 'rqtrk', 'amazon-adsystem',
      ];
      if (type === 'image' || type === 'font' || type === 'media') {
        req.abort();
        return;
      }
      if (AD_NOISE.some((needle) => url.includes(needle))) {
        req.abort();
        return;
      }

      if (!resolved && /playlist\.php/i.test(url)) {
        resolved = {
          url,
          headers: {
            Referer: req.headers()['referer'] || candidateEmbedUrl,
            Origin: (() => {
              try {
                return new URL(req.headers()['referer'] || candidateEmbedUrl).origin;
              } catch (e) {
                return undefined;
              }
            })(),
            'User-Agent': DEFAULT_HEADERS['User-Agent'],
          },
        };
      }

      req.continue();
    });

    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    console.log(`[librefutbol/browser] página del canal cargada, seteando iframe -> ${candidateEmbedUrl}`);

    // En vez de buscar y clickear el botón exacto (frágil si cambia texto
    // o clase), replicamos directamente lo que el click termina haciendo:
    // asignarle al iframe el data-src del servidor elegido.
    await page.evaluate((src) => {
      const frame = document.querySelector('iframe#playerFrame, iframe#player-frame');
      if (frame) frame.src = src;
    }, candidateEmbedUrl);

    const start = Date.now();
    while (!resolved && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!resolved) {
      console.log(`[librefutbol/browser] timeout (${timeoutMs}ms) sin ver ningún playlist.php para ${candidateEmbedUrl}`);
    } else {
      console.log(`[librefutbol/browser] playlist.php capturado: ${resolved.url}`);
    }

    if (resolved) {
      // Copiamos también las cookies que el sitio haya seteado durante
      // este flujo -- si el CDN además de validar el sig depende de una
      // cookie de sesión, sin esto seguiría dando 403 aunque el sig sea
      // el correcto.
      try {
        const cdnOrigin = new URL(resolved.url).origin;
        const cookies = await page.cookies(cdnOrigin, channelUrl);
        if (cookies.length > 0) {
          resolved.headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      } catch (e) {
        /* sin cookies extra, seguimos igual */
      }
    }

    return resolved;
  } catch (e) {
    console.log(`[librefutbol/browser] error resolviendo ${candidateEmbedUrl}: ${e.message}`);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

module.exports = { resolvePlaylistViaBrowser };
