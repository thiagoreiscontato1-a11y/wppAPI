const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('../index.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const authPath = path.join(__dirname, '.wwebjs_auth');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let qrDataUrl = null;
let state = 'starting';
let lastError = null;
let client;
const profilePictureCache = new Map();
const profilePictureRequests = new Map();

function publishStatus() {
  io.emit('status', { state, qrDataUrl, error: lastError });
}

function serializeMessage(msg) {
  return {
    id: msg.id?._serialized,
    body: msg.body || '',
    type: msg.type || 'chat',
    fromMe: Boolean(msg.fromMe),
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    author: msg._data?.notifyName || msg._data?.pushname || '',
    hasMedia: Boolean(msg.hasMedia),
  };
}

async function startClient() {
  state = 'starting';
  lastError = null;
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
  client.on('ready', () => {
    qrDataUrl = null;
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
    const chats = await client.getChats();
    const result = chats.map((chat) => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: Boolean(chat.isGroup),
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        lastMessage: chat.lastMessage?.body || '',
        number: chat.id.user,
        profilePic: null,
      }));
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
  try {
    const sent = await client.sendMessage(req.params.id, body);
    res.status(201).json(serializeMessage(sent));
  } catch (error) { res.status(500).json({ error: error.message }); }
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
  socket.emit('status', { state, qrDataUrl, error: lastError });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`WPPAPI Chat disponível na porta ${port}`);
  startClient();
});

process.on('SIGINT', async () => {
  try { await client?.destroy(); } catch {}
  process.exit(0);
});
