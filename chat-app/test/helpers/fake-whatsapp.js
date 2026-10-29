const { EventEmitter } = require('events');
const MessageMedia = require('../../../src/structures/MessageMedia');

// Cliente falso com a mesma interface usada pelo chat, para testar o servidor sem WhatsApp.
function createFakeWhatsApp({ history = [], chats = [] } = {}) {
  const instances = [];
  const calls = [];
  const sent = [];
  let sentCount = 0;

  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.info = { pushname: 'Thiago Reis', wid: { _serialized: '5511999999999@c.us' } };
      this.pupPage = { isClosed: () => false, evaluate: async () => chats.map((chat) => ({ unreadCount: 0, lastMessage: '', number: chat.id.split('@')[0], isGroup: false, profilePic: null, ...chat })) };
      instances.push(this);
    }
    async initialize() { calls.push('initialize'); setImmediate(() => this.emit('ready')); }
    async destroy() { calls.push('destroy'); }
    async logout() { calls.push('logout'); }
    async sendSeen(id) { calls.push(`seen:${id}`); return true; }
    async getProfilePicUrl(id) { calls.push(`pic:${id}`); return `https://pps.whatsapp.net/${id}.jpg?oe=${Math.floor(Date.now() / 1000 + 3600).toString(16)}`; }
    async getChatById(id) { return { fetchMessages: async ({ limit }) => { calls.push(`fetch:${id}:${limit}`); return history.slice(-limit); } }; }
    async getContactById(id) { calls.push(`contact:${id}`); return { name: id === '5511888888888@c.us' ? 'Maria' : null }; }
    async getContactLidAndPhone() { return [{ pn: '5511777777777@c.us' }]; }
    async getFormattedNumber(id) { return `+55 ${id.split('@')[0].slice(2)}`; }
    async getMessageById(id) {
      calls.push(`getmsg:${id}`);
      if (id === 'missing') return null;
      if (id.startsWith('html')) return { hasMedia: true, downloadMedia: async () => ({ mimetype: 'text/html', filename: 'convite.html', data: Buffer.from('<script>alert(1)</script>').toString('base64') }) };
      return { hasMedia: true, downloadMedia: async () => ({ mimetype: 'video/mp4', filename: 'clipe.mp4', data: Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)).toString('base64') }) };
    }
    async sendMessage(to, content, options = {}) {
      sentCount += 1;
      const base = { id: { _serialized: `sent-${sentCount}` }, fromMe: true, ack: 0, timestamp: Math.floor(Date.now() / 1000), _data: {} };
      if (typeof content === 'string') { sent.push({ to, body: content, options }); return { ...base, body: content, type: 'chat' }; }
      sent.push({ to, mimetype: content.mimetype, filename: content.filename, size: Buffer.from(content.data, 'base64').length, options });
      return { ...base, body: '', type: options.sendMediaAsDocument ? 'document' : content.mimetype.split('/')[0], hasMedia: true, _data: { filename: content.filename } };
    }
  }

  class FakeLocalAuth {
    constructor(options) { this.options = options; }
  }

  return { Client: FakeClient, LocalAuth: FakeLocalAuth, MessageMedia, instances, calls, sent, current: () => instances[instances.length - 1] };
}

function makeHistory(count, from = 'ana@c.us') {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: count }, (_, i) => ({ id: { _serialized: `h${i}` }, body: `histórico ${i}`, from, fromMe: false, type: 'chat', timestamp: now - (count - i) * 60, _data: {} }));
}

module.exports = { createFakeWhatsApp, makeHistory };
