const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../lib/cache');
const { profilePictureExpiry, parseByteRange, mediaResponseHeaders, isPlayableUpload } = require('../lib/media');
const { serializeMessage, fetchMessagesPage, createMessageSerializer } = require('../lib/messages');
const { createLoginLimiter, createOriginCheck, isSameOrigin, codespacesOrigin, LOGIN_MAX_FAILURES_PER_IP, LOGIN_MAX_FAILURES_GLOBAL } = require('../lib/auth');
const { makeHistory } = require('./helpers/fake-whatsapp');

test('cache expira itens, guarda null e descarta os menos usados', () => {
  let now = 0;
  const cache = createCache({ maxEntries: 2, ttlMs: 100, now: () => now });
  cache.set('a', 1);
  cache.set('b', null);
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), 1); // 'a' passa a ser o mais recente
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.size, 2);
  now = 150;
  assert.equal(cache.get('a'), undefined);
  cache.set('d', 4, { expiresAt: 1000 });
  now = 999;
  assert.equal(cache.get('d'), 4);
});

test('cache respeita o limite de bytes', () => {
  const cache = createCache({ maxBytes: 10, sizeOf: (value) => value.length });
  cache.set('a', 'xxxxxx');
  cache.set('b', 'yyyyyy');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.bytes, 6);
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test('validade das fotos segue o parâmetro oe do WhatsApp', () => {
  const now = 1_000_000_000_000;
  const inTenMinutes = Math.floor(now / 1000 + 600).toString(16);
  assert.equal(profilePictureExpiry(`https://pps.whatsapp.net/a.jpg?oe=${inTenMinutes}`, now), now + 5 * 60 * 1000);
  assert.equal(profilePictureExpiry('https://pps.whatsapp.net/a.jpg', now), now + 60 * 60 * 1000);
  assert.equal(profilePictureExpiry(null, now), now + 10 * 60 * 1000);
  assert.equal(profilePictureExpiry('https://pps.whatsapp.net/a.jpg?oe=1', now), now + 60 * 1000);
});

test('intervalos de bytes', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(parseByteRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.deepEqual(parseByteRange('bytes=200-300', 100), { invalid: true });
  assert.equal(parseByteRange('bytes=-', 100), null);
  assert.equal(parseByteRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseByteRange(undefined, 100), null);
});

test('cabeçalhos de mídia só abrem no navegador tipos seguros', () => {
  const html = mediaResponseHeaders({ mimetype: 'text/html', filename: 'a"b.html' });
  assert.match(html['Content-Disposition'], /^attachment; filename="a_b.html"/);
  assert.match(html['Content-Security-Policy'], /sandbox/);
  assert.match(mediaResponseHeaders({ mimetype: 'image/svg+xml' })['Content-Disposition'], /^attachment/);
  assert.match(mediaResponseHeaders({ mimetype: 'video/mp4', filename: 'vídeo.mp4' })['Content-Disposition'], /^inline; .*filename\*=UTF-8''v%C3%ADdeo\.mp4/);
  assert.equal(mediaResponseHeaders({ mimetype: 'application/pdf' })['Content-Security-Policy'], undefined);
  assert.equal(isPlayableUpload('image/png'), true);
  assert.equal(isPlayableUpload('audio/mpeg'), true);
  assert.equal(isPlayableUpload('video/quicktime'), false);
  assert.equal(isPlayableUpload('application/pdf'), false);
});

test('serializeMessage traz confirmação, nome do arquivo e citação', () => {
  const message = serializeMessage({ id: { _serialized: 'm1' }, body: 'oi', fromMe: true, ack: 2, timestamp: 10, hasMedia: true, _data: { filename: 'a.pdf', quotedMsg: { id: { _serialized: 'q1', fromMe: false }, body: 'antes' } } });
  assert.equal(message.ack, 2);
  assert.equal(message.filename, 'a.pdf');
  assert.deepEqual(message.quotedMessage, { id: 'q1', body: 'antes', type: 'chat', fromMe: false, hasMedia: false });
  assert.equal(serializeMessage({ id: { _serialized: 'm2' } }).ack, null);
});

test('paginação de mensagens anteriores', async () => {
  const history = makeHistory(130);
  const chat = { fetchMessages: async ({ limit }) => history.slice(-limit) };
  const ids = (page) => page.messages.map((msg) => msg.id._serialized);
  let page = await fetchMessagesPage(chat, 50);
  assert.deepEqual([ids(page)[0], ids(page).at(-1), page.hasMore], ['h80', 'h129', true]);
  page = await fetchMessagesPage(chat, 50, 'h80');
  assert.deepEqual([ids(page)[0], ids(page).at(-1), page.hasMore], ['h30', 'h79', true]);
  page = await fetchMessagesPage(chat, 50, 'h30');
  assert.deepEqual([ids(page).length, ids(page)[0], page.hasMore], [30, 'h0', false]);
  page = await fetchMessagesPage(chat, 50, 'não-existe');
  assert.deepEqual(page, { messages: [], hasMore: false });
  page = await fetchMessagesPage(chat, 50, 'h100', 64);
  assert.equal(page.hasMore, true, 'limite de busca atingido ainda indica que há mais');
});

test('autor das mensagens de grupo: nome salvo, número do LID ou número formatado', async () => {
  const client = {
    getContactById: async (id) => ({ name: id === '5511888888888@c.us' ? 'Maria' : null }),
    getContactLidAndPhone: async () => [{ pn: '5511777777777@c.us' }],
    getFormattedNumber: async (id) => `+55 ${id.split('@')[0].slice(2)}`,
  };
  const serialize = createMessageSerializer({ getClient: () => client, contactNames: createCache() });
  assert.equal((await serialize({ id: { _serialized: 'a' }, author: '5511888888888@c.us' })).author, 'Maria');
  assert.equal((await serialize({ id: { _serialized: 'b' }, author: '123@lid' })).author, '+55 11777777777');
  assert.equal((await serialize({ id: { _serialized: 'c' } })).author, '');
});

test('limite de tentativas de login por IP e geral', () => {
  const limiter = createLoginLimiter();
  const start = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) limiter.fail('1.1.1.1', start);
  assert.ok(limiter.check('1.1.1.1', start) > 14 * 60 * 1000);
  assert.equal(limiter.check('2.2.2.2', start), 0);
  assert.equal(limiter.check('1.1.1.1', start + 15 * 60 * 1000 + 1), 0, 'bloqueio termina');
  limiter.fail('3.3.3.3', start);
  limiter.succeed('3.3.3.3');
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP - 1; i += 1) limiter.fail('3.3.3.3', start);
  assert.equal(limiter.check('3.3.3.3', start), 0, 'login certo zera a contagem do IP');

  const global = createLoginLimiter();
  for (let i = 0; i < LOGIN_MAX_FAILURES_GLOBAL; i += 1) global.fail(`10.0.0.${i}`, start);
  assert.ok(global.check('9.9.9.9', start) > 0, 'muitas falhas de IPs diferentes bloqueiam todos');
});

test('verificação de origem', () => {
  const req = (headers) => ({ headers: { host: 'chat.example', ...headers } });
  assert.equal(isSameOrigin(req({})), true);
  assert.equal(isSameOrigin(req({ origin: 'https://chat.example' })), true);
  assert.equal(isSameOrigin(req({ origin: 'https://evil.example' })), false);
  assert.equal(isSameOrigin(req({ referer: 'https://evil.example/x' })), false);
  assert.equal(isSameOrigin(req({ origin: 'lixo' })), false);
});

test('Codespaces e ALLOWED_ORIGINS liberam proxies que reescrevem o Host', () => {
  const codespaces = codespacesOrigin({ CODESPACE_NAME: 'ideal-space-xyz', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' });
  const req = (origin) => ({ headers: { host: 'localhost:3000', origin } });
  assert.equal(isSameOrigin(req('https://ideal-space-xyz-3000.app.github.dev')), false, 'sem liberação o Host reescrito é recusado');
  assert.equal(isSameOrigin(req('https://ideal-space-xyz-3000.app.github.dev'), [codespaces]), true);
  assert.equal(isSameOrigin(req('https://outro-space-3000.app.github.dev'), [codespaces]), false);
  assert.equal(isSameOrigin(req('https://ideal-space-xyz-3000.app.github.dev.evil.com'), [codespaces]), false);
  assert.equal(isSameOrigin(req('https://chat.exemplo.com'), ['https://chat.exemplo.com']), true);
  assert.equal(codespacesOrigin({}), null);

  const warnings = [];
  const check = createOriginCheck({ logger: { warn: (message) => warnings.push(message) } });
  check(req('https://evil.example/a'));
  check(req('https://evil.example/b'));
  assert.equal(warnings.length, 1, 'avisa uma vez por origem');
  assert.match(warnings[0], /https:\/\/evil\.example .*localhost:3000.*ALLOWED_ORIGINS/);
});
