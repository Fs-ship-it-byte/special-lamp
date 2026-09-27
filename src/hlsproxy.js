const fetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('./http');

// ==========================================
// PROXY DE HLS (m3u8 + segmentos)
// ==========================================
// El master.m3u8 de estos CDNs lleva Referer/Origin/UA "negociados" al
// pedirlo. Si le damos esa URL cruda a Stremio, el player la pide sin esos
// headers y el CDN la rechaza. Reescribimos el playlist entero para que
// cada sub-playlist y cada segmento .ts también pasen por acá con los
// mismos headers.

function publicUrl() {
  return (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 7000}`).replace(
    /\/$/,
    ''
  );
}

function encodeProxyToken(url, headers) {
  return Buffer.from(JSON.stringify({ url, headers: headers || {} }), 'utf8').toString(
    'base64url'
  );
}

function decodeProxyToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function makeAbsolute(url, base) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) {
    try {
      return new URL(base).origin + url;
    } catch (e) {
      return base + url;
    }
  }
  return `${base}/${url}`;
}

function isM3u8Url(u) {
  return /\.m3u8(\?|#|$)/i.test(u);
}

function buildProxyPlaylistUrl(targetUrl, headers) {
  const token = encodeProxyToken(targetUrl, headers);
  return `${publicUrl()}/hlsproxy/playlist/${token}/master.m3u8`;
}

function buildProxyDirectUrl(targetUrl, headers) {
  const token = encodeProxyToken(targetUrl, headers);
  return `${publicUrl()}/hlsproxy/direct/${token}/file`;
}

// No decidimos "sub-playlist vs segmento" por extensión (algunos CDNs
// nombran raro sus sub-playlists), sino por la etiqueta que las precede:
// #EXT-X-STREAM-INF siempre indica que la línea siguiente es sub-playlist.
function rewriteM3u8(playlistText, baseUrl, headers) {
  const lines = playlistText.split(/\r?\n/);
  let nextIsPlaylist = false;
  const base = baseUrl.replace(/\/[^/]*$/, '');

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      const upper = trimmed.toUpperCase();

      if (upper.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
        return line.replace(/URI="([^"]+)"/i, (m, uri) => {
          const abs = makeAbsolute(uri, base);
          const token = encodeProxyToken(abs, headers);
          return `URI="${publicUrl()}/hlsproxy/playlist/${token}/sub.m3u8"`;
        });
      }

      const rewritten = line.replace(/URI="([^"]+)"/i, (m, uri) => {
        const abs = makeAbsolute(uri, base);
        const token = encodeProxyToken(abs, headers);
        return `URI="${publicUrl()}/hlsproxy/segment/${token}/seg"`;
      });

      nextIsPlaylist = upper.startsWith('#EXT-X-STREAM-INF');
      return rewritten;
    }

    const absUrl = /^https?:\/\//i.test(trimmed) ? trimmed : makeAbsolute(trimmed, base);
    const token = encodeProxyToken(absUrl, headers);
    const isPlaylist = nextIsPlaylist || isM3u8Url(absUrl);
    nextIsPlaylist = false;
    return isPlaylist
      ? `${publicUrl()}/hlsproxy/playlist/${token}/sub.m3u8`
      : `${publicUrl()}/hlsproxy/segment/${token}/seg`;
  });

  return out.join('\n');
}

async function handlePlaylistProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: { 'User-Agent': DEFAULT_HEADERS['User-Agent'], ...data.headers },
    });
    if (!upstream.ok) {
      console.log(`[hlsproxy] playlist ${data.url} -> HTTP ${upstream.status}`);
      return res.status(upstream.status).send('No se pudo obtener el playlist');
    }
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, data.url, data.headers);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (e) {
    console.log('[hlsproxy] playlist error', data.url, e.message);
    res.status(502).send('No se pudo obtener el playlist');
  }
}

async function handleSegmentProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        ...data.headers,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    res.status(upstream.status);
    res.set('Access-Control-Allow-Origin', '*');
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.set('Content-Length', cl);
    upstream.body.pipe(res);
  } catch (e) {
    res.status(502).send('No se pudo obtener el segmento');
  }
}

async function handleDirectProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        ...data.headers,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      redirect: 'follow',
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        return;
      }
      res.setHeader(key, value);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.body.pipe(res);
  } catch (e) {
    res.status(502).send(`proxy error: ${e.message}`);
  }
}

module.exports = {
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
};
