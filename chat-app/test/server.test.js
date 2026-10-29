const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatServer } = require('../app');
const { createFakeWhatsApp, makeHistory } = require('./helpers/fake-whatsapp');

const silent = { log() {}, warn() {}, error() {} };

async function startServer(options = {}) {
  const fake = createFakeWhatsApp({ history: makeHistory(130), chats: [{ id: 'ana@c.us', name: 'Ana', timestamp: 10 }, { id: 'bia@c.us', name: 'Bia', timestamp: 20 }] });
  const chat = createChatServer({ ...fake, authPath: '/tmp/nao-usado', logger: silent, maxUploadBytes: 1024 * 1024, sessionOptions: { reconnectDelayMs: 20 }, ...options });
  const { port } = await chat.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (path, { headers = {}, json, ...init } = {}) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : init.body,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const waitFor = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'condição não foi atingida');
  };
  await waitFor(() => chat.session.state === 'ready');
  return { chat, fake, base, request, waitFor, clearCookie: () => { cookie = ''; } };
}

test('login: tela de login, sessão em cookie, bloqueio e saída', async (t) => {
  const { chat, request, clearCookie } = await startServer({ appPassword: 'segredo' });
  t.after(() => chat.close());

  let response = await request('/', { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login.html');
  assert.equal((await request('/api/chats')).status, 401);
  assert.equal((await request('/socket.io/?EIO=4&transport=polling')).status, 401);
  assert.equal((await request('/login.html')).status, 200);

  for (let i = 0; i < 5; i += 1) assert.equal((await request('/api/login', { method: 'POST', json: { user: 'admin', password: 'x' }, headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 401);
  response = await request('/api/login', { method: 'POST', json: { user: 'admin', password: 'segredo' }, headers: { 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);

  response = await request('/api/login', { method: 'POST', json: { user: 'admin', password: 'segredo' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const status = await (await request('/api/status')).json();
  assert.equal(status.authEnabled, true);
  assert.equal(status.me.name, 'Thiago Reis');

  await request('/api/session/logout', { method: 'POST' });
  assert.equal((await request('/api/status')).status, 401);
  clearCookie();
});

test('pedidos de outra origem são recusados', async (t) => {
  const { chat, request, base } = await startServer();
  t.after(() => chat.close());
  assert.equal((await request('/api/restart', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/socket.io/?EIO=4&transport=polling', { headers: { Origin: base } })).status, 200);
  const headers = (await request('/healthz')).headers;
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-powered-by'), null);
});

test('conversas, histórico paginado e marcar como lida', async (t) => {
  const { chat, fake, request } = await startServer();
  t.after(() => chat.close());
  const chats = await (await request('/api/chats')).json();
  assert.deepEqual(chats.map((item) => item.id), ['bia@c.us', 'ana@c.us']);
  let page = await (await request('/api/chats/ana%40c.us/messages?limit=80')).json();
  assert.equal(page.messages.length, 80);
  assert.equal(page.hasMore, true);
  page = await (await request(`/api/chats/ana%40c.us/messages?limit=50&before=${page.messages[0].id}`)).json();
  assert.deepEqual([page.messages[0].id, page.messages.at(-1).id, page.hasMore], ['h0', 'h49', false]);
  assert.equal((await request('/api/chats/ana%40c.us/seen', { method: 'POST' })).status, 200);
  assert.ok(fake.calls.includes('seen:ana@c.us'));
});

test('envio de texto, arquivos e figurinhas', async (t) => {
  const { chat, fake, request } = await startServer();
  t.after(() => chat.close());
  let response = await request('/api/chats/ana%40c.us/messages', { method: 'POST', json: { body: 'oi', quotedMessageId: 'h1' } });
  assert.equal(response.status, 201);
  assert.deepEqual(fake.sent.at(-1), { to: 'ana@c.us', body: 'oi', options: { quotedMessageId: 'h1' } });

  const upload = (name, type, size) => request('/api/chats/ana%40c.us/files', { method: 'POST', body: Buffer.alloc(size, 1), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': type, 'X-File-Name': encodeURIComponent(name) } });
  assert.equal((await upload('relatório.pdf', 'application/pdf', 300)).status, 201);
  assert.deepEqual(fake.sent.at(-1), { to: 'ana@c.us', mimetype: 'application/pdf', filename: 'relatório.pdf', size: 300, options: { sendMediaAsDocument: true } });
  assert.equal((await upload('foto.png', 'image/png', 200)).status, 201);
  assert.deepEqual(fake.sent.at(-1).options, {});
  assert.equal((await upload('../../etc/passwd', 'text/plain', 10)).status, 201);
  assert.equal(fake.sent.at(-1).filename, '.._.._etc_passwd');
  response = await upload('grande.zip', 'application/zip', 2 * 1024 * 1024);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /1 MB/);

  response = await request('/api/chats/ana%40c.us/stickers', { method: 'POST', json: { data: Buffer.alloc(6 * 1024 * 1024).toString('base64'), mimetype: 'image/png' } });
  assert.equal(response.status, 413);
  response = await request('/api/chats/ana%40c.us/stickers', { method: 'POST', json: { data: 'AAAA', mimetype: 'image/svg+xml' } });
  assert.equal(response.status, 400);
});

test('mídia com pedidos parciais, cache e tipos perigosos', async (t) => {
  const { chat, fake, request } = await startServer();
  t.after(() => chat.close());
  let response = await request('/api/media/v1', { headers: { Range: 'bytes=10-19' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  response = await request('/api/media/v1');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^inline/);
  assert.equal(fake.calls.filter((call) => call === 'getmsg:v1').length, 1, 'baixada uma vez só');
  assert.equal((await request('/api/media/v1', { headers: { Range: 'bytes=5000-' } })).status, 416);
  response = await request('/api/media/html1');
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await request('/api/media/missing')).status, 404);
});

test('reconexão: queda da sessão, Tentar novamente e sair do WhatsApp', async (t) => {
  const { chat, fake, request, waitFor } = await startServer();
  t.after(() => chat.close());
  const old = fake.current();
  old.emit('disconnected', 'UNPAIRED');
  assert.equal(chat.session.state, 'disconnected');
  await waitFor(() => fake.instances.length === 2 && chat.session.state === 'ready');
  old.emit('disconnected', 'UNPAIRED');
  assert.equal(chat.session.state, 'ready', 'eventos do cliente antigo são ignorados');

  assert.equal((await request('/api/restart', { method: 'POST' })).status, 202);
  await waitFor(() => fake.instances.length === 3 && chat.session.state === 'ready');
  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  assert.ok(fake.calls.includes('logout'));
  await waitFor(() => fake.instances.length === 4 && chat.session.state === 'ready');
});

test('fotos de perfil ficam em cache e podem ser renovadas', async (t) => {
  const { chat, fake, request } = await startServer();
  t.after(() => chat.close());
  const first = await (await request('/api/chats/ana%40c.us/profile-picture')).json();
  await request('/api/chats/ana%40c.us/profile-picture');
  assert.equal(fake.calls.filter((call) => call === 'pic:ana@c.us').length, 1);
  await request('/api/chats/ana%40c.us/profile-picture?refresh=1');
  assert.equal(fake.calls.filter((call) => call === 'pic:ana@c.us').length, 2);
  assert.match(first.url, /oe=/);
});

test('sem APP_PASSWORD a interface abre direto', async (t) => {
  const { chat, request } = await startServer();
  t.after(() => chat.close());
  assert.equal((await request('/', { headers: { Accept: 'text/html' } })).status, 200);
  assert.equal((await (await request('/api/status')).json()).authEnabled, false);
});

test('atrás do proxy do Codespaces (Host reescrito) o tempo real e o login funcionam', async (t) => {
  const codespace = 'https://ideal-space-xyz-3000.app.github.dev';
  const { chat, request } = await startServer({ appPassword: 'segredo', allowedOrigins: [/^https:\/\/ideal-space-xyz-\d+\.app\.github\.dev$/] });
  t.after(() => chat.close());
  const headers = { Origin: codespace, Host: 'localhost:3000' };
  assert.equal((await request('/api/login', { method: 'POST', json: { user: 'admin', password: 'segredo' }, headers })).status, 200);
  assert.equal((await request('/socket.io/?EIO=4&transport=polling', { headers })).status, 200);
  assert.equal((await request('/api/restart', { method: 'POST', headers: { Origin: 'https://evil.example', Host: 'localhost:3000' } })).status, 403);
});
