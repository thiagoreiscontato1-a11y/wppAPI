const { EventEmitter } = require('events');
const QRCode = require('qrcode');

const TRANSIENT_ERROR = /execution context was destroyed|cannot find context with specified id|target closed|session closed|detached frame/i;

// Mantém um cliente da whatsapp-web.js por vez: conecta, reconecta quando a sessão cai e
// avisa as mudanças por eventos ('status', 'message', 'ack', 'reset').
function createWhatsAppSession({ Client, LocalAuth, authPath, logger = console, reconnectDelayMs = 3000, logoutReconnectDelayMs = 20000 }) {
  const events = new EventEmitter();
  let client = null;
  let state = 'starting';
  let qrDataUrl = null;
  let lastError = null;
  let loadingPercent = null;
  let me = null;
  let reconnectTimer = null;
  let restartPromise = null;

  function status() {
    return { state, qrDataUrl, error: lastError, loadingPercent, me };
  }

  function publish() {
    events.emit('status', status());
  }

  async function start() {
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
      publish();
    });
    on('authenticated', () => {
      qrDataUrl = null;
      state = 'authenticated';
      publish();
    });
    on('loading_screen', (percent, label) => {
      loadingPercent = Number.isFinite(Number(percent)) ? Number(percent) : null;
      logger.log(`Sincronização do WhatsApp: ${loadingPercent ?? '?'}%${label ? ` (${label})` : ''}`);
      publish();
    });
    on('ready', () => {
      me = { name: current.info?.pushname || '', id: current.info?.wid?._serialized || '' };
      qrDataUrl = null;
      loadingPercent = null;
      state = 'ready';
      publish();
    });
    on('auth_failure', (message) => {
      lastError = String(message);
      state = 'error';
      publish();
    });
    on('disconnected', (reason) => {
      state = 'disconnected';
      lastError = String(reason || 'Sessão desconectada');
      publish();
      scheduleReconnect(reason === 'LOGOUT' ? logoutReconnectDelayMs : reconnectDelayMs);
    });
    on('message', (msg) => events.emit('message', { chatId: msg.from, msg }));
    on('message_create', (msg) => { if (msg.fromMe) events.emit('message', { chatId: msg.to, msg }); });
    on('message_ack', (msg, ack) => events.emit('ack', { id: msg.id?._serialized, ack }));
    try {
      await current.initialize();
    } catch (error) {
      if (client !== current) return;
      logger.error('Falha ao inicializar o WhatsApp:', error);
      state = 'error';
      lastError = error.message;
      publish();
    }
  }

  // Após um LOGOUT a própria biblioteca costuma gerar um novo QR; só reinicia se isso não acontecer.
  function scheduleReconnect(delayMs) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (state === 'disconnected') {
        logger.log('Sessão do WhatsApp caiu; reiniciando a conexão...');
        restart();
      }
    }, delayMs);
  }

  function restart() {
    restartPromise ||= (async () => {
      clearTimeout(reconnectTimer);
      const previous = client;
      client = null;
      state = 'starting';
      lastError = null;
      qrDataUrl = null;
      loadingPercent = null;
      publish();
      try { await previous?.destroy(); } catch {}
      me = null;
      events.emit('reset');
      start();
    })().finally(() => { restartPromise = null; });
    return restartPromise;
  }

  async function logout() {
    if (client) await client.logout();
    restart();
  }

  async function destroy() {
    clearTimeout(reconnectTimer);
    const current = client;
    client = null;
    try { await current?.destroy(); } catch {}
  }

  async function getProfilePicture(chatId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.getProfilePicUrl(chatId);
      } catch (error) {
        if (!TRANSIENT_ERROR.test(String(error?.message || error))) throw error;
        if (attempt < 2 && state === 'ready' && client?.pupPage && !client.pupPage.isClosed()) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        logger.warn(`Contexto do WhatsApp reiniciou durante a busca de foto (${chatId}); usando avatar padrão.`);
        return undefined;
      }
    }
    return undefined;
  }

  return {
    events,
    start,
    restart,
    logout,
    destroy,
    status,
    getProfilePicture,
    get client() { return client; },
    get state() { return state; },
  };
}

module.exports = { createWhatsAppSession };
