const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavedStickers, findSavedStickersInPage, downloadSavedStickerInPage } = require('../lib/stickers');
const { createChatServer } = require('../app');
const { createFakeWhatsApp } = require('./helpers/fake-whatsapp');

const silent = { log() {}, warn() {}, error() {} };

// WhatsApp Web simulado: só o necessário para as funções que rodam dentro da página.
function fakePage({ modules = {}, collections = {}, debug = true } = {}) {
  const registry = { WAWebCollections: collections, ...modules };
  if (debug) registry.__debug = { modulesMap: Object.fromEntries(Object.keys(registry).map((name) => [name, {}])) };
  return {
    require(name) {
      if (!(name in registry)) throw new Error(`módulo ${name} não existe`);
      return registry[name];
    },
    WWebJS: { arrayBufferToBase64Async: async (buffer) => Buffer.from(buffer).toString('base64') },
  };
}
const collectionOf = (models) => ({ getModelsArray: () => models });

test('figurinhas salvas: acha a coleção de favoritas pelos módulos e baixa pelo gerenciador do WhatsApp', async (t) => {
  const models = [
    { id: 'f1', filehash: 'h1', mimetype: 'image/webp', isAnimated: true, mediaKey: 'segredo', directPath: '/d1' },
    { filehash: 'h2' },
  ];
  const calls = [];
  global.window = fakePage({
    collections: { Msg: collectionOf([]), StickerPack: collectionOf([{}]) },
    modules: {
      WAWebFavoriteStickerCollection: { FavoriteStickerCollection: collectionOf(models) },
      WAWebMediaInMemoryBlobCache: { InMemoryMediaBlobCache: { get: () => null } },
      WAWebDownloadManager: { downloadManager: { downloadAndMaybeDecrypt: async (options) => { calls.push(options); return new Uint8Array([82, 73, 70, 70]).buffer; } } },
    },
  });
  t.after(() => { delete global.window; });

  const { stickers, diagnostics } = findSavedStickersInPage();
  assert.deepEqual(stickers, [{ id: 'f1', mimetype: 'image/webp', isAnimated: true }, { id: 'h2', mimetype: 'image/webp', isAnimated: false }]);
  assert.equal(diagnostics.source, 'WAWebFavoriteStickerCollection.FavoriteStickerCollection');
  assert.equal(diagnostics.count, 2);
  assert.deepEqual(diagnostics.collectionKeys, ['StickerPack']);
  assert.equal(diagnostics.sampleFields.mediaKey, 'string');
  assert.ok(!JSON.stringify(diagnostics).includes('segredo'), 'o diagnóstico não pode levar a chave de mídia');

  const downloaded = await downloadSavedStickerInPage('f1');
  assert.deepEqual(downloaded, { data: 'UklGRg==', mimetype: 'image/webp' });
  assert.equal(calls[0].type, 'sticker');
  assert.equal(calls[0].directPath, '/d1');
  assert.match((await downloadSavedStickerInPage('nao-existe')).error, /não encontrada/);
});

test('figurinhas salvas: sem coleção de favoritas, devolve lista vazia com diagnóstico', async (t) => {
  global.window = fakePage({ collections: { StickerPack: collectionOf([]) }, debug: false });
  t.after(() => { delete global.window; });
  const { stickers, diagnostics } = findSavedStickersInPage();
  assert.deepEqual(stickers, []);
  assert.equal(diagnostics.source, null);
  assert.ok(diagnostics.errors.some((error) => error.startsWith('__debug')));
  assert.ok(diagnostics.modules.includes('WAWebFavoriteStickerCollection'));
});

test('figurinhas salvas: guarda a imagem baixada e repassa o erro da página', async () => {
  const store = new Map();
  let evaluations = 0;
  const client = { pupPage: { evaluate: async (_fn, id) => { evaluations += 1; return id === 'ok' ? { data: 'UklGRg==', mimetype: 'image/webp' } : { error: 'sem acesso' }; } } };
  const saved = createSavedStickers({ getClient: () => client, cache: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) } });
  assert.equal((await saved.image('ok')).buffer.length, 4);
  await saved.image('ok');
  assert.equal(evaluations, 1);
  await assert.rejects(saved.image('ruim'), /sem acesso/);
});

test('rotas de figurinhas salvas: lista, imagem e envio como figurinha', async (t) => {
  const fake = createFakeWhatsApp({ chats: [{ id: 'ana@c.us', name: 'Ana', timestamp: 10 }] });
  const savedStickers = {
    list: async () => ({ stickers: [{ id: 'f/1', mimetype: 'image/webp', isAnimated: false }], diagnostics: { source: 'teste' } }),
    image: async (id) => {
      if (id !== 'f/1') throw new Error('Figurinha não encontrada.');
      return { mimetype: 'image/webp', data: 'UklGRg==', buffer: Buffer.from('RIFF') };
    },
  };
  const chat = createChatServer({ ...fake, authPath: '/tmp/nao-usado', logger: silent, savedStickers });
  const { port } = await chat.listen(0, '127.0.0.1');
  t.after(() => chat.close());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && chat.session.state !== 'ready'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  const list = await (await fetch(`${base}/api/stickers/saved`)).json();
  assert.equal(list.stickers[0].id, 'f/1');

  let response = await fetch(`${base}/api/stickers/saved/${encodeURIComponent('f/1')}/image`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'RIFF');
  assert.equal((await fetch(`${base}/api/stickers/saved/outra/image`)).status, 502);

  response = await fetch(`${base}/api/chats/ana%40c.us/stickers/saved/${encodeURIComponent('f/1')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quotedMessageId: 'q1' }) });
  assert.equal(response.status, 201);
  const sent = fake.sent.at(-1);
  assert.equal(sent.to, 'ana@c.us');
  assert.equal(sent.mimetype, 'image/webp');
  assert.equal(sent.options.sendMediaAsSticker, true);
  assert.equal(sent.options.quotedMessageId, 'q1');
});
