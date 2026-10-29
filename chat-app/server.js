const path = require('path');
const express = require('express');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('../index.js');
const { createAuth, isSameOrigin } = require('./auth');

const app = express();
const server = http.createServer(app);
// Recusa conexões em tempo real abertas por outros sites (sequestro de WebSocket).
const io = new Server(server, { allowRequest: (req, callback) => callback(null, isSameOrigin(req)) });
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const authPath = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
const appUser = process.env.APP_USER || 'admin';
const appPassword = process.env.APP_PASSWORD || '';

if (!appPassword && process.env.NODE_ENV === 'production') {
  console.error('Defina a variável APP_PASSWORD antes de publicar o chat: sem ela qualquer pessoa com o link acessa o WhatsApp.');
  process.exit(1);
}
if (!appPassword) console.warn('APP_PASSWORD não definida: a interface está sem senha. Use apenas em ambiente privado.');

const auth = createAuth({ user: appUser, password: appPassword });
const STICKER_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_INLINE_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/;

// Atrás do Caddy (rede interna do Docker) o IP real do visitante vem em X-Forwarded-For.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, uniquelocal');
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true, state }));
app.use(auth.requireSameOrigin);
app.use(auth.requireLogin);
io.engine.use(auth.requireLogin);
app.use(express.json({ limit: '10mb' }));
app.post('/api/login', auth.login);
app.post('/api/session/logout', auth.logout);
app.use(express.static(path.join(__dirname, 'public')));

let qrDataUrl = null;
let state = 'starting';
let lastError = null;
let loadingPercent = null;
let client;
const profilePictureCache = new Map();
const profilePictureRequests = new Map();
const contactNameCache = new Map();
const PROFILE_PICTURE_TTL_MS = 60 * 60 * 1000;
const PROFILE_PICTURE_MISS_TTL_MS = 10 * 60 * 1000;
const MESSAGE_FETCH_MAX = 2000;
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 32) * 1024 * 1024;
const mediaCache = new Map();
const mediaRequests = new Map();
let mediaCacheBytes = 0;
let me = null;
let reconnectTimer = null;
let restartPromise = null;

// Os links de foto do WhatsApp expiram (parâmetro hexadecimal `oe`); renova antes disso.
function profilePictureExpiry(url) {
  const now = Date.now();
  if (!url) return now + PROFILE_PICTURE_MISS_TTL_MS;
  let expiresAt = now + PROFILE_PICTURE_TTL_MS;
  try {
    const oe = parseInt(new URL(url).searchParams.get('oe'), 16);
    if (Number.isFinite(oe)) expiresAt = Math.min(expiresAt, oe * 1000 - 5 * 60 * 1000);
  } catch {}
  return Math.max(expiresAt, now + 60 * 1000);
}

async function getProfilePictureWithRetry(chatId) {
  const transientPattern = /execution context was destroyed|cannot find context with specified id|target closed|session closed|detached frame/i;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.getProfilePicUrl(chatId);
    } catch (error) {
      const message = String(error?.message || error);
      if (!transientPattern.test(message)) throw error;
      if (attempt < 2 && state === 'ready' && client?.pupPage && !client.pupPage.isClosed()) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      console.warn(`Contexto do WhatsApp reiniciou durante a busca de foto (${chatId}); usando avatar padrão.`);
      return undefined;
    }
  }
  return undefined;
}

function statusPayload() {
  return { state, qrDataUrl, error: lastError, loadingPercent, me, maxUploadBytes, authEnabled: auth.enabled };
}

function publishStatus() {
  io.emit('status', statusPayload());
}

// Busca `limit` mensagens anteriores a `beforeId` (ou as mais recentes). A biblioteca só
// carrega a partir do fim da conversa, então amplia a busca até alcançar a mensagem de referência.
async function fetchMessagesPage(chat, limit, beforeId) {
  let fetchLimit = beforeId ? limit * 2 : limit;
  for (;;) {
    const messages = await chat.fetchMessages({ limit: fetchLimit });
    const reachedStart = messages.length < fetchLimit;
    const end = beforeId ? messages.findIndex((msg) => msg.id?._serialized === beforeId) : messages.length;
    if (end >= 0 && (end >= limit || reachedStart || fetchLimit >= MESSAGE_FETCH_MAX)) {
      return { messages: messages.slice(Math.max(0, end - limit), end), hasMore: end > limit || (!reachedStart && fetchLimit < MESSAGE_FETCH_MAX) };
    }
    if (reachedStart || fetchLimit >= MESSAGE_FETCH_MAX) return { messages: [], hasMore: false };
    fetchLimit = Math.min(fetchLimit * 2, MESSAGE_FETCH_MAX);
  }
}

// Navegadores pedem vídeos e áudios em pedaços; guarda as mídias recentes para não baixar de novo a cada pedaço.
function getMediaEntry(messageId) {
  const cached = mediaCache.get(messageId);
  if (cached) {
    mediaCache.delete(messageId);
    mediaCache.set(messageId, cached);
    return Promise.resolve(cached);
  }
  let request = mediaRequests.get(messageId);
  if (!request) {
    request = (async () => {
      const message = await client.getMessageById(messageId);
      if (!message?.hasMedia) return { status: 404, error: 'Mídia não encontrada.' };
      const media = await message.downloadMedia();
      if (!media?.data) return { status: 404, error: 'Não foi possível baixar esta mídia.' };
      const entry = { mimetype: media.mimetype || 'application/octet-stream', filename: media.filename, buffer: Buffer.from(media.data, 'base64') };
      if (entry.buffer.length <= MEDIA_CACHE_MAX_BYTES / 4) {
        mediaCache.set(messageId, entry);
        mediaCacheBytes += entry.buffer.length;
        for (const [id, old] of mediaCache) {
          if (mediaCacheBytes <= MEDIA_CACHE_MAX_BYTES) break;
          mediaCache.delete(id);
          mediaCacheBytes -= old.buffer.length;
        }
      }
      return entry;
    })().finally(() => mediaRequests.delete(messageId));
    mediaRequests.set(messageId, request);
  }
  return request;
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : { invalid: true };
}

function serializeMessage(msg) {
  const quoted = msg._data?.quotedMsg;
  const quotedId = quoted?.id?._serialized || quoted?.id?.$1 || quoted?.id || null;
  return {
    id: msg.id?._serialized,
    body: msg.body || '',
    type: msg.type || 'chat',
    isGif: Boolean(msg._data?.isGif || msg.isGif || msg.type === 'gif'),
    fromMe: Boolean(msg.fromMe),
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    ack: Number.isInteger(msg.ack) ? msg.ack : null,
    author: msg._data?.notifyName || msg._data?.pushname || '',
    authorId: msg.author || null,
    hasMedia: Boolean(msg.hasMedia),
    filename: msg._data?.filename || null,
    quotedMessage: quoted ? {
      id: quotedId,
      body: quoted.body || quoted.caption || '',
      type: quoted.type || 'chat',
      fromMe: Boolean(quoted.id?.fromMe),
      hasMedia: Boolean(quoted.directPath),
    } : null,
  };
}


async function getContactDisplayName(contactId) {
  if (!contactId) return null;
  if (!contactNameCache.has(contactId)) {
    const lookup = client.getContactById(contactId)
      .then((contact) => contact?.name || contact?.pushname || contact?.shortName || null)
      .catch(() => null);
    contactNameCache.set(contactId, lookup);
  }
  return contactNameCache.get(contactId);
}

async function serializeMessageForChat(msg) {
  const serialized = serializeMessage(msg);
  const authorId = msg.author;
  if (!authorId) return serialized;

  serialized.authorId = authorId;
  let lookupId = authorId;
  let displayName = await getContactDisplayName(lookupId);
  let phoneId = authorId.includes('@lid') ? null : authorId;

  if (!displayName && authorId.includes('@lid')) {
    try {
      const [resolved] = await client.getContactLidAndPhone([authorId]);
      phoneId = resolved?.pn || null;
      if (phoneId) {
        lookupId = phoneId;
        displayName = await getContactDisplayName(lookupId);
      }
    } catch {}
  }

  if (displayName) {
    serialized.author = displayName;
    return serialized;
  }

  if (phoneId) {
    try {
      serialized.author = await client.getFormattedNumber(phoneId);
    } catch {}
    serialized.author ||= phoneId.split('@')[0].replace(/:\d+$/, '');
    return serialized;
  }

  serialized.author ||= 'Participante';
  return serialized;
}
async function startClient() {
  state = 'starting';
  lastError = null;
  loadingPercent = null;
  const current = new Client({
    authStrategy: new LocalAuth({ clientId: 'wppapi-chat', dataPath: authPath }),
    puppeteer: {
      headless: true,
      protocolTimeout: 300000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
  client = current;
  // Ignora eventos de um cliente antigo que já foi substituído por uma reconexão.
  const on = (event, handler) => current.on(event, (...args) => {
    if (client === current) return handler(...args);
  });

  on('qr', async (qr) => {
    qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
    state = 'qr';
    publishStatus();
  });
  on('authenticated', () => {
    qrDataUrl = null;
    state = 'authenticated';
    publishStatus();
  });
  on('loading_screen', (percent, label) => {
    loadingPercent = Number.isFinite(Number(percent)) ? Number(percent) : null;
    console.log(`Sincronização do WhatsApp: ${loadingPercent ?? '?'}%${label ? ` (${label})` : ''}`);
    publishStatus();
  });
  on('ready', () => {
    me = { name: current.info?.pushname || '', id: current.info?.wid?._serialized || '' };
    qrDataUrl = null;
    loadingPercent = null;
    state = 'ready';
    publishStatus();
  });
  on('auth_failure', (message) => {
    lastError = String(message);
    state = 'error';
    publishStatus();
  });
  on('disconnected', (reason) => {
    state = 'disconnected';
    lastError = String(reason || 'Sessão desconectada');
    publishStatus();
    scheduleReconnect(reason === 'LOGOUT' ? 20000 : 3000);
  });
  on('message', async (msg) => {
    const message = await serializeMessageForChat(msg);
    io.emit('message', { chatId: msg.from, message });
  });
  on('message_create', async (msg) => {
    if (msg.fromMe) {
      const message = await serializeMessageForChat(msg);
      io.emit('message', { chatId: msg.to, message });
    }
  });
  on('message_ack', (msg, ack) => io.emit('ack', { id: msg.id?._serialized, ack }));
  try {
    await current.initialize();
  } catch (error) {
    if (client !== current) return;
    console.error('Falha ao inicializar o WhatsApp:', error);
    state = 'error';
    lastError = error.message;
    publishStatus();
  }
}

// Após um LOGOUT a própria biblioteca costuma gerar um novo QR; só reinicia se isso não acontecer.
function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (state === 'disconnected') {
      console.log('Sessão do WhatsApp caiu; reiniciando a conexão...');
      restartClient();
    }
  }, delayMs);
}

function restartClient() {
  restartPromise ||= (async () => {
    clearTimeout(reconnectTimer);
    const previous = client;
    client = null;
    state = 'starting';
    lastError = null;
    qrDataUrl = null;
    loadingPercent = null;
    publishStatus();
    try { await previous?.destroy(); } catch {}
    me = null;
    profilePictureCache.clear();
    contactNameCache.clear();
    mediaCache.clear();
    mediaCacheBytes = 0;
    startClient();
  })().finally(() => { restartPromise = null; });
  return restartPromise;
}

app.get('/api/status', (_req, res) => res.json(statusPayload()));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

app.get('/api/chats/:id/profile-picture', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const chatId = req.params.id;
  try {
    const cached = profilePictureCache.get(chatId);
    if (!cached || cached.expiresAt <= Date.now() || req.query.refresh) {
      let request = profilePictureRequests.get(chatId);
      if (!request) {
        request = getProfilePictureWithRetry(chatId)
          .finally(() => profilePictureRequests.delete(chatId));
        profilePictureRequests.set(chatId, request);
      }
      const url = await request || null;
      profilePictureCache.set(chatId, { url, expiresAt: profilePictureExpiry(url) });
    }
    res.json({ url: profilePictureCache.get(chatId).url });
  } catch (error) {
    console.warn(`Foto de perfil indisponível para ${chatId}: ${error.message}`);
    res.json({ url: null });
  }
});

app.get('/api/media/:messageId', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  try {
    const media = await getMediaEntry(req.params.messageId);
    if (media.error) return res.status(media.status).json({ error: media.error });
    const { buffer } = media;
    res.setHeader('Content-Type', media.mimetype);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');
    // Arquivos recebidos podem ser HTML ou SVG com scripts: só tipos seguros abrem no navegador,
    // os demais são baixados, e nada servido daqui roda scripts na origem do chat.
    const inline = MEDIA_INLINE_TYPES.test(media.mimetype);
    if (media.mimetype !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    const safeName = (media.filename || 'arquivo').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(media.filename || 'arquivo')}`);
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
    console.error('Falha ao baixar mídia da mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chats', async (_req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  try {
    const result = await client.pupPage.evaluate(() => {
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
          lastMessage: lastMessage?.body || lastMessage?.caption || '',
          number: chat.id?.user || '',
          profilePic: null,
        };
      }).filter((chat) => chat.id);
    });
    result.sort((a, b) => b.timestamp - a.timestamp);
    res.json(result);
  } catch (error) {
    console.error('Falha ao carregar conversas do WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chats/:id/messages', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  try {
    const chat = await client.getChatById(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
    const before = String(req.query.before || '').trim() || null;
    const page = await fetchMessagesPage(chat, limit, before);
    res.json({ messages: await Promise.all(page.messages.map(serializeMessageForChat)), hasMore: page.hasMore });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/chats/:id/messages', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Escreva uma mensagem.' });
  const quotedMessageId = String(req.body?.quotedMessageId || '').trim();
  try {
    const sent = await client.sendMessage(req.params.id, body, quotedMessageId ? { quotedMessageId } : {});
    res.status(201).json(serializeMessage(sent));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/chats/:id/seen', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  try {
    await client.sendSeen(req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Recebe o arquivo como binário (application/octet-stream); o tipo real vem em X-File-Type.
app.post('/api/chats/:id/files', express.raw({ type: 'application/octet-stream', limit: maxUploadBytes }), async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecione um arquivo.' });
  const mimetype = String(req.headers['x-file-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  let filename = 'arquivo';
  try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')).replace(/[\r\n\\/]/g, '_').slice(0, 200) || filename; } catch {}
  const quotedMessageId = String(req.headers['x-quoted-message-id'] || '').trim();
  const options = {};
  if (quotedMessageId) options.quotedMessageId = quotedMessageId;
  // Formatos que o WhatsApp mostra direto na conversa; o resto vai como documento.
  if (!/^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|x-m4a|opus))$/.test(mimetype)) options.sendMediaAsDocument = true;
  try {
    const media = new MessageMedia(mimetype, req.body.toString('base64'), filename, req.body.length);
    const sent = await client.sendMessage(req.params.id, media, options);
    res.status(201).json(serializeMessage(sent));
  } catch (error) {
    console.error('Falha ao enviar arquivo:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chats/:id/stickers', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const { data, mimetype, filename, quotedMessageId } = req.body || {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'Selecione uma imagem para a figurinha.' });
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimetype || ''))) return res.status(400).json({ error: 'Escolha uma imagem PNG, JPEG ou WebP.' });
  if (Buffer.byteLength(data, 'base64') > STICKER_MAX_BYTES) return res.status(413).json({ error: 'A imagem da figurinha deve ter até 5 MB.' });
  try {
    const media = new MessageMedia(mimetype, data, filename || 'figurinha');
    const options = { sendMediaAsSticker: true };
    if (quotedMessageId) options.quotedMessageId = String(quotedMessageId);
    const sent = await client.sendMessage(req.params.id, media, options);
    res.status(201).json(serializeMessage(sent));
  } catch (error) {
    console.error('Falha ao enviar figurinha:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chats/:id/media', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const { data, mimetype, filename, quotedMessageId } = req.body || {};
  const type = String(mimetype || '').toLowerCase();
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'Não encontrei uma mídia na área de transferência.' });
  if (!['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(type)) return res.status(400).json({ error: 'Formato não suportado. Cole um GIF ou uma imagem.' });
  if (Buffer.byteLength(data, 'base64') > 7 * 1024 * 1024) return res.status(413).json({ error: 'A mídia deve ter até 7 MB.' });
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
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
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
    const sent = await client.sendMessage(req.params.id, media, options);
    res.status(201).json(serializeMessage(sent));
  } catch (error) {
    console.error('Falha ao enviar mídia colada:', error);
    if (error.code === 'ENOENT') return res.status(500).json({ error: 'FFmpeg não está instalado. Execute npm run setup novamente.' });
    res.status(500).json({ error: error.message });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/logout', async (_req, res) => {
  try {
    if (client) await client.logout();
    restartClient();
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/restart', (_req, res) => {
  restartClient();
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

server.listen(port, '0.0.0.0', () => {
  console.log(`WPPAPI Chat disponível na porta ${port}`);
  startClient();
});

async function shutdown() {
  try { await client?.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
