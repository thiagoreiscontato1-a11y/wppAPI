const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('../index.js');
const { createChatServer } = require('./app');

const port = Number(process.env.PORT || 3000);
const appPassword = process.env.APP_PASSWORD || '';

if (!appPassword && process.env.NODE_ENV === 'production') {
  console.error('Defina a variável APP_PASSWORD antes de publicar o chat: sem ela qualquer pessoa com o link acessa o WhatsApp.');
  process.exit(1);
}
if (!appPassword) console.warn('APP_PASSWORD não definida: a interface está sem senha. Use apenas em ambiente privado.');

const chat = createChatServer({
  Client,
  LocalAuth,
  MessageMedia,
  authPath: process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.wwebjs_auth'),
  appUser: process.env.APP_USER || 'admin',
  appPassword,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 32) * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY || 'loopback, uniquelocal',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
});

chat.listen(port, '0.0.0.0').then(() => console.log(`WPPAPI Chat disponível na porta ${port}`));

async function shutdown() {
  try { await chat.session.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
