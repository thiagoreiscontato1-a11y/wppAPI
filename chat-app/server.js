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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const authPath = path.join(__dirname, '.wwebjs_auth');
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let qrDataUrl = null;
let state = 'starting';
let lastError = null;
let loadingPercent = null;
let client;
const profilePictureCache = new Map();
const profilePictureRequests = new Map();

function publishStatus() {
  io.emit('status', { state, qrDataUrl, error: lastError, loadingPercent });
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
    author: msg._data?.notifyName || msg._data?.pushname || '',
    hasMedia: Boolean(msg.hasMedia),
    quotedMessage: quoted ? {
      id: quotedId,
      body: quoted.body || quoted.caption || '',
      type: quoted.type || 'chat',
      fromMe: Boolean(quoted.id?.fromMe),
      hasMedia: Boolean(quoted.directPath),
    } : null,
  };
}

async function startClient() {
  state = 'starting';
  lastError = null;
  loadingPercent = null;
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'wppapi-chat', dataPath: authPath }),
    puppeteer: {
      headless: true,
      protocolTimeout: 300000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', async (qr) => {
    qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
    state = 'qr';
    publishStatus();
  });
  client.on('authenticated', () => {
    qrDataUrl = null;
    state = 'authenticated';
    publishStatus();
  });
  client.on('loading_screen', (percent, label) => {
    loadingPercent = Number.isFinite(Number(percent)) ? Number(percent) : null;
    console.log(`Sincronização do WhatsApp: ${loadingPercent ?? '?'}%${label ? ` (${label})` : ''}`);
    publishStatus();
  });
  client.on('ready', () => {
    qrDataUrl = null;
    loadingPercent = null;
    state = 'ready';
    publishStatus();
  });
  client.on('auth_failure', (message) => {
    lastError = String(message);
    state = 'error';
    publishStatus();
  });
  client.on('disconnected', (reason) => {
    state = 'disconnected';
    lastError = String(reason || 'Sessão desconectada');
    publishStatus();
  });
  client.on('message', (msg) => io.emit('message', { chatId: msg.from, message: serializeMessage(msg) }));
  client.on('message_create', (msg) => {
    if (msg.fromMe) io.emit('message', { chatId: msg.to, message: serializeMessage(msg) });
  });
  client.on('message_ack', (msg, ack) => io.emit('ack', { id: msg.id?._serialized, ack }));
  try {
    await client.initialize();
  } catch (error) {
    console.error('Falha ao inicializar o WhatsApp:', error);
    state = 'error';
    lastError = error.message;
    publishStatus();
  }
}

app.get('/api/status', (_req, res) => res.json({ state, qrDataUrl, error: lastError }));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

app.get('/api/chats/:id/profile-picture', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const chatId = req.params.id;
  try {
    if (!profilePictureCache.has(chatId)) {
      let request = profilePictureRequests.get(chatId);
      if (!request) {
        request = client.getProfilePicUrl(chatId)
          .catch((error) => { throw error; })
          .finally(() => profilePictureRequests.delete(chatId));
        profilePictureRequests.set(chatId, request);
      }
      profilePictureCache.set(chatId, await request || null);
    }
    res.json({ url: profilePictureCache.get(chatId) });
  } catch (error) {
    console.error('Falha ao carregar foto de perfil:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/media/:messageId', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  try {
    const message = await client.getMessageById(req.params.messageId);
    if (!message?.hasMedia) return res.status(404).json({ error: 'Mídia não encontrada.' });
    const media = await message.downloadMedia();
    if (!media?.data) return res.status(404).json({ error: 'Não foi possível baixar esta mídia.' });
    const buffer = Buffer.from(media.data, 'base64');
    res.setHeader('Content-Type', media.mimetype || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (media.filename) {
      const safeName = media.filename.replace(/[\r\n"\\]/g, '_');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    }
    res.send(buffer);
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
    const messages = await chat.fetchMessages({ limit: Math.min(Number(req.query.limit) || 60, 100) });
    res.json(messages.map(serializeMessage));
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

app.post('/api/chats/:id/stickers', async (req, res) => {
  if (state !== 'ready') return res.status(409).json({ error: 'Conecte o WhatsApp primeiro.' });
  const { data, mimetype, filename, quotedMessageId } = req.body || {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'Selecione uma imagem para a figurinha.' });
  if (!String(mimetype || '').startsWith('image/')) return res.status(400).json({ error: 'O arquivo precisa ser uma imagem.' });
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
    state = 'disconnected';
    qrDataUrl = null;
    publishStatus();
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

io.on('connection', (socket) => {
  socket.emit('status', { state, qrDataUrl, error: lastError, loadingPercent });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`WPPAPI Chat disponível na porta ${port}`);
  startClient();
});

process.on('SIGINT', async () => {
  try { await client?.destroy(); } catch {}
  process.exit(0);
});
