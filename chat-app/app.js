const path = require('path');
const express = require('express');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Server } = require('socket.io');
const { createAuth, createOriginCheck } = require('./lib/auth');
const { createCache } = require('./lib/cache');
const { profilePictureExpiry, parseByteRange, mediaResponseHeaders, isPlayableUpload } = require('./lib/media');
const { serializeMessage, fetchMessagesPage, createMessageSerializer } = require('./lib/messages');
const { createWhatsAppSession } = require('./lib/whatsapp');

const execFileAsync = promisify(execFile);
const STICKER_MAX_BYTES = 5 * 1024 * 1024;
const PASTED_MEDIA_MAX_BYTES = 7 * 1024 * 1024;
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;

// Monta o servidor do chat. A biblioteca (Client, LocalAuth, MessageMedia) é recebida por
// parâmetro para que os testes possam usar um cliente falso.
function createChatServer({
  Client,
  LocalAuth,
  MessageMedia,
  authPath,
  appUser = 'admin',
  appPassword = '',
  maxUploadBytes = 32 * 1024 * 1024,
  trustProxy = 'loopback, uniquelocal',
  allowedOrigins = [],
  ffmpegPath = 'ffmpeg',
  logger = console,
  sessionOptions = {},
}) {
  const app = express();
  const server = http.createServer(app);
  const isAllowedOrigin = createOriginCheck({ allowedOrigins, logger });
  // Recusa conexões em tempo real abertas por outros sites (sequestro de WebSocket).
  const io = new Server(server, { allowRequest: (req, callback) => callback(null, isAllowedOrigin(req)) });
  const auth = createAuth({ user: appUser, password: appPassword, isAllowedOrigin });
  const session = createWhatsAppSession({ Client, LocalAuth, authPath, logger, ...sessionOptions });
  const profilePictures = createCache({ maxEntries: 2000 });
  const profilePictureRequests = new Map();
  const contactNames = createCache({ maxEntries: 5000, ttlMs: 60 * 60 * 1000 });
  const mediaCache = createCache({ maxBytes: MEDIA_CACHE_MAX_BYTES, sizeOf: (entry) => entry.buffer.length, ttlMs: 10 * 60 * 1000 });
  const mediaRequests = new Map();
  const serializeMessageForChat = createMessageSerializer({ getClient: () => session.client, contactNames });

  const statusPayload = () => ({ ...session.status(), maxUploadBytes, authEnabled: auth.enabled });
  const requireReady = (_req, res, next) => (session.state === 'ready' ? next() : res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' }));

  session.events.on('status', () => io.emit('status', statusPayload()));
  session.events.on('ack', (payload) => io.emit('ack', payload));
  session.events.on('message', async ({ chatId, msg }) => {
    try {
      io.emit('message', { chatId, message: await serializeMessageForChat(msg) });
    } catch (error) {
      logger.error('Falha ao repassar mensagem recebida:', error);
    }
  });
  session.events.on('reset', () => {
    profilePictures.clear();
    contactNames.clear();
    mediaCache.clear();
  });

  // Navegadores pedem vídeos e áudios em pedaços; guarda as mídias recentes para não baixar de novo a cada pedaço.
  function getMediaEntry(messageId) {
    const cached = mediaCache.get(messageId);
    if (cached) return Promise.resolve(cached);
    let request = mediaRequests.get(messageId);
    if (!request) {
      request = (async () => {
        const message = await session.client.getMessageById(messageId);
        if (!message?.hasMedia) return { status: 404, error: 'Mídia não encontrada.' };
        const media = await message.downloadMedia();
        if (!media?.data) return { status: 404, error: 'Não foi possível baixar esta mídia.' };
        const entry = { mimetype: media.mimetype || 'application/octet-stream', filename: media.filename, buffer: Buffer.from(media.data, 'base64') };
        if (entry.buffer.length <= MEDIA_CACHE_MAX_BYTES / 4) mediaCache.set(messageId, entry);
        return entry;
      })().finally(() => mediaRequests.delete(messageId));
      mediaRequests.set(messageId, request);
    }
    return request;
  }

  // Atrás do Caddy (rede interna do Docker) o IP real do visitante vem em X-Forwarded-For.
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, state: session.state }));
  app.use(auth.requireSameOrigin);
  app.use(auth.requireLogin);
  io.engine.use(auth.requireLogin);
  app.use(express.json({ limit: '10mb' }));
  app.post('/api/login', auth.login);
  app.post('/api/session/logout', auth.logout);
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', (_req, res) => res.json(statusPayload()));
  app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

  app.get('/api/chats/:id/profile-picture', requireReady, async (req, res) => {
    const chatId = req.params.id;
    try {
      let url = profilePictures.get(chatId);
      if (url === undefined || req.query.refresh) {
        let request = profilePictureRequests.get(chatId);
        if (!request) {
          request = session.getProfilePicture(chatId).finally(() => profilePictureRequests.delete(chatId));
          profilePictureRequests.set(chatId, request);
        }
        url = await request || null;
        profilePictures.set(chatId, url, { expiresAt: profilePictureExpiry(url) });
      }
      res.json({ url });
    } catch (error) {
      logger.warn(`Foto de perfil indisponível para ${chatId}: ${error.message}`);
      res.json({ url: null });
    }
  });

  app.get('/api/media/:messageId', requireReady, async (req, res) => {
    try {
      const media = await getMediaEntry(req.params.messageId);
      if (media.error) return res.status(media.status).json({ error: media.error });
      const { buffer } = media;
      res.set(mediaResponseHeaders(media));
      const range = parseByteRange(req.headers.range, buffer.length);
      if (range?.invalid) {
        res.setHeader('Content-Range', `bytes */${buffer.length}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
        return res.end(buffer.subarray(range.start, range.end + 1));
      }
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
    } catch (error) {
      logger.error('Falha ao baixar mídia da mensagem:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/chats', requireReady, async (_req, res) => {
    try {
      const result = await session.client.pupPage.evaluate(() => {
        const collection = window.require('WAWebCollections');
        return collection.Chat.getModelsArray().map((chat) => {
          const id = chat.id?._serialized || '';
          const lastMessageId = chat.lastReceivedKey?._serialized || chat.lastReceivedKey?.$1;
          const lastMessage = lastMessageId ? collection.Msg.get(lastMessageId) : null;
          return {
            id,
            name: chat.formattedTitle || chat.name || chat.id?.user || id,
            isGroup: Boolean(chat.groupMetadata || id.endsWith('@g.us')),
            unreadCount: Number(chat.unreadCount || 0),
            timestamp: Number(chat.t || 0),
            // Hora em que a conversa foi fixada no WhatsApp (0 = não fixada).
            pinnedAt: Number(chat.pin || 0),
            lastMessage: lastMessage?.body || lastMessage?.caption || '',
            number: chat.id?.user || '',
            profilePic: null,
          };
        }).filter((chat) => chat.id);
      });
      // Como no WhatsApp: fixadas no topo (a fixada por último primeiro), depois as mais recentes.
      result.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0) || b.timestamp - a.timestamp);
      res.json(result);
    } catch (error) {
      logger.error('Falha ao carregar conversas do WhatsApp:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/chats/:id/messages', requireReady, async (req, res) => {
    try {
      const chat = await session.client.getChatById(req.params.id);
      const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
      const before = String(req.query.before || '').trim() || null;
      const page = await fetchMessagesPage(chat, limit, before);
      res.json({ messages: await Promise.all(page.messages.map(serializeMessageForChat)), hasMore: page.hasMore });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/chats/:id/messages', requireReady, async (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Escreva uma mensagem.' });
    const quotedMessageId = String(req.body?.quotedMessageId || '').trim();
    try {
      const sent = await session.client.sendMessage(req.params.id, body, quotedMessageId ? { quotedMessageId } : {});
      res.status(201).json(serializeMessage(sent));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/chats/:id/seen', requireReady, async (req, res) => {
    try {
      await session.client.sendSeen(req.params.id);
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  // Recebe o arquivo como binário (application/octet-stream); o tipo real vem em X-File-Type.
  app.post('/api/chats/:id/files', requireReady, express.raw({ type: 'application/octet-stream', limit: maxUploadBytes }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecione um arquivo.' });
    const mimetype = String(req.headers['x-file-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    let filename = 'arquivo';
    try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')).replace(/[\r\n\\/]/g, '_').slice(0, 200) || filename; } catch {}
    const quotedMessageId = String(req.headers['x-quoted-message-id'] || '').trim();
    const options = {};
    if (quotedMessageId) options.quotedMessageId = quotedMessageId;
    if (!isPlayableUpload(mimetype)) options.sendMediaAsDocument = true;
    try {
      const media = new MessageMedia(mimetype, req.body.toString('base64'), filename, req.body.length);
      const sent = await session.client.sendMessage(req.params.id, media, options);
      res.status(201).json(serializeMessage(sent));
    } catch (error) {
      logger.error('Falha ao enviar arquivo:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/chats/:id/stickers', requireReady, async (req, res) => {
    const { data, mimetype, filename, quotedMessageId } = req.body || {};
    if (!data || typeof data !== 'string') return res.status(400).json({ error: 'Selecione uma imagem para a figurinha.' });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimetype || ''))) return res.status(400).json({ error: 'Escolha uma imagem PNG, JPEG ou WebP.' });
    if (Buffer.byteLength(data, 'base64') > STICKER_MAX_BYTES) return res.status(413).json({ error: 'A imagem da figurinha deve ter até 5 MB.' });
    try {
      const media = new MessageMedia(mimetype, data, filename || 'figurinha');
      const options = { sendMediaAsSticker: true };
      if (quotedMessageId) options.quotedMessageId = String(quotedMessageId);
      const sent = await session.client.sendMessage(req.params.id, media, options);
      res.status(201).json(serializeMessage(sent));
    } catch (error) {
      logger.error('Falha ao enviar figurinha:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/chats/:id/media', requireReady, async (req, res) => {
    const { data, mimetype, filename, quotedMessageId } = req.body || {};
    const type = String(mimetype || '').toLowerCase();
    if (!data || typeof data !== 'string') return res.status(400).json({ error: 'Não encontrei uma mídia na área de transferência.' });
    if (!['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(type)) return res.status(400).json({ error: 'Formato não suportado. Cole um GIF ou uma imagem.' });
    if (Buffer.byteLength(data, 'base64') > PASTED_MEDIA_MAX_BYTES) return res.status(413).json({ error: 'A mídia deve ter até 7 MB.' });
    let tempDir;
    try {
      let media;
      const options = {};
      if (quotedMessageId) options.quotedMessageId = String(quotedMessageId);
      if (type === 'image/gif') {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wppapi-gif-'));
        const inputPath = path.join(tempDir, 'input.gif');
        const outputPath = path.join(tempDir, 'output.mp4');
        await fs.writeFile(inputPath, Buffer.from(data, 'base64'));
        await execFileAsync(ffmpegPath, [
          '-y', '-i', inputPath, '-vf', 'fps=15,scale=min(640\\,iw):-2:flags=lanczos,format=yuv420p',
          '-t', '15', '-an', '-movflags', '+faststart', outputPath,
        ]);
        const mp4 = await fs.readFile(outputPath);
        media = new MessageMedia('video/mp4', mp4.toString('base64'), (filename || 'animacao.gif').replace(/\.gif$/i, '.mp4'));
        options.sendVideoAsGif = true;
      } else {
        media = new MessageMedia(type, data, filename || 'imagem');
        if (type === 'video/mp4') options.sendVideoAsGif = true;
      }
      const sent = await session.client.sendMessage(req.params.id, media, options);
      res.status(201).json(serializeMessage(sent));
    } catch (error) {
      logger.error('Falha ao enviar mídia colada:', error);
      if (error.code === 'ENOENT') return res.status(500).json({ error: 'FFmpeg não está instalado. Execute npm run setup novamente.' });
      res.status(500).json({ error: error.message });
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.post('/api/logout', async (_req, res) => {
    try {
      await session.logout();
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/restart', (_req, res) => {
    session.restart();
    res.status(202).json({ ok: true });
  });

  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: `O arquivo deve ter até ${Math.round(maxUploadBytes / 1024 / 1024)} MB.` });
    }
    next(error);
  });

  io.on('connection', (socket) => {
    socket.emit('status', statusPayload());
  });

  return {
    app,
    server,
    io,
    session,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => {
        session.start();
        resolve(server.address());
      }));
    },
    async close() {
      await session.destroy();
      io.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createChatServer };
