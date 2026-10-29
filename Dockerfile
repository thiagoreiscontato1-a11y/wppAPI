# Imagem para publicar a interface chat-app em um servidor.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ffmpeg fonts-liberation fonts-noto-color-emoji ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WWEBJS_AUTH_PATH=/data/.wwebjs_auth \
    PORT=3000

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY chat-app/package.json chat-app/
RUN npm --prefix chat-app install --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY chat-app ./chat-app

RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /app/chat-app
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
