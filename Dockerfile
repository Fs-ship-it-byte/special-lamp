FROM node:20-slim

WORKDIR /app

# Puppeteer necesita estas librerías del sistema para poder correr Chromium
# headless en el contenedor (sin esto, "puppeteer.launch()" falla con
# errores de librerías compartidas faltantes, tipo
# "error while loading shared libraries: libnss3.so").
#
# Instalamos Chromium DEL SISTEMA (paquete "chromium" de Debian) en vez de
# dejar que el propio puppeteer descargue su binario en el paso de "npm
# install": esa descarga (~170MB desde el CDN de Google) puede fallar con
# HTTP 403 en algunos entornos de build (Render incluido, según lo que
# vimos) y tira todo el build abajo sin avisar bien por qué. Usando el
# Chromium de apt evitamos depender de esa descarga por completo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Le decimos a puppeteer que NO intente descargar su propio Chromium
# durante "npm install", y dónde encontrar el que ya instalamos por apt.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Instalamos deps primero (capa cacheable) antes de copiar el resto del código.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=7000
EXPOSE 7000

CMD ["node", "src/index.js"]
