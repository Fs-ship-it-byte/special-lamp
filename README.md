# LibreFutbol — addon de Stremio

Addon de canales de TV en vivo, portado desde `TvLibrefutbolProvider` (Kotlin,
app Android Streamflix) a un addon standalone de Stremio en Node.

## Cómo funciona

1. **Catálogo**: se scrapea en vivo el HTML de `librefutbol2.com` con 3
   estrategias en cascada (igual que el original Kotlin):
   - `div#channels a.channel-card` (canales "deportes" en HTML estático)
   - un bloque `<script>` que contiene `showChannels`, con canales
     "regionales" inyectados vía JS (regex sobre el template string)
   - fallback: cualquier `<a href="*.php">` del documento
   - Se cachea 10 minutos en memoria (`CACHE_TTL_MS`) para no pegarle al
     sitio en cada apertura del catálogo.

2. **Stream**: para un canal, se sigue `iframe#player-frame` -> se busca
   `playlist.php` por regex en el HTML de ese iframe -> se arma la URL de
   nuestro propio proxy HLS (`hlsproxy.js`) con los headers fijos que el
   CDN real (`ksdjugfssddeports.com`) exige (`Origin`/`Referer` del embed).

3. **Proxy HLS**: el manifest y cada segmento `.ts` pasan por
   `/hlsproxy/playlist/...` y `/hlsproxy/segment/...` para inyectar esos
   headers -- el reproductor de Stremio no puede mandarlos directamente.

## Correr en local

```bash
npm install
PUBLIC_URL=http://127.0.0.1:7000 npm start
```

Después instalar en Stremio con `http://127.0.0.1:7000/manifest.json`.

## Deploy (Render, Railway u otro)

Necesitás setear la variable de entorno `PUBLIC_URL` con la URL pública
donde quede desplegado (el proxy la necesita para armar los links que le
da a Stremio). Sin `puppeteer` de por medio, este addon es liviano -- no
necesita nada más que Node.

### Render (Web Service con Docker)

1. Nuevo **Web Service** -> conectar el repo -> Render detecta el
   `Dockerfile` solo (Environment: Docker).
2. Render inyecta su propio `PORT` automáticamente -- no hace falta
   tocarlo, `src/index.js` ya lee `process.env.PORT`.
3. Agregar la variable de entorno `PUBLIC_URL` con la URL pública que
   Render te asigna (algo como `https://tu-servicio.onrender.com`) --
   **sin barra final**. Sin esto el proxy arma links rotos.
4. Instalar en Stremio con `https://tu-servicio.onrender.com/manifest.json`.

Nota: el plan free de Render duerme el servicio tras inactividad, así que
el primer pedido después de un rato dormido va a tardar más (cold start).

## Cosas para revisar si deja de andar

- **Dominio**: `MAIN_URL` en `src/providers/librefutbol.js` -- si el sitio
  cambia de dominio (paso frecuente en este tipo de sitios), hay que
  actualizarlo ahí.
- **Selectores CSS**: si el sitio rehace su plantilla, revisar
  `extractChannelsFromHtml` (los 3 pasos en cascada).
- **CDN de video**: si `ksdjugfssddeports.com` cambia de dominio/puerto,
  hay que actualizar `VIDEO_CDN_HOST_MATCHES`/`VIDEO_CDN_HEADERS` en
  `src/http.js` y los `cdnHeaders` hardcodeados en `getStreams`.
- **`iframe#player-frame` o `playlist.php`**: si cambia el patrón del
  reproductor embebido, revisar `getStreams` en el provider.

## Posible próximo paso

`TvporinternetHDProvider` (Kotlin) es prácticamente el mismo sitio con
otro dominio/branding, y comparte el mismo backend de video
(`ksdjugfssddeports.com`). Se podría agregar como una segunda fuente
dentro de este mismo provider (o un segundo archivo en `src/providers/`)
sin duplicar la lógica de resolución del stream -- solo cambia de dónde
sale el catálogo.
