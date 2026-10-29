// Figurinhas salvas (favoritas) do WhatsApp. A whatsapp-web.js não tem função para isso, então o
// servidor lê direto do WhatsApp Web: procura a coleção de favoritas entre os módulos internos e
// baixa cada figurinha pelos mecanismos do próprio WhatsApp. Os nomes internos mudam entre versões,
// por isso a busca é tolerante e devolve um diagnóstico do que encontrou.

// Roda dentro da página do WhatsApp Web (via pupPage.evaluate): não pode usar nada de fora.
function findSavedStickersInPage() {
  const diagnostics = { collectionKeys: [], modules: [], candidates: [], source: null, count: 0, sampleFields: {}, errors: [] };
  const isCollection = (value) => Boolean(value) && typeof value.getModelsArray === 'function';
  const candidates = [];
  const addCandidates = (name, exported) => {
    if (isCollection(exported)) candidates.push({ name, collection: exported });
    else if (exported && typeof exported === 'object') {
      for (const [key, value] of Object.entries(exported)) if (isCollection(value)) candidates.push({ name: `${name}.${key}`, collection: value });
    }
  };

  try {
    const collections = window.require('WAWebCollections');
    for (const key of Object.keys(collections)) {
      if (!/sticker/i.test(key)) continue;
      diagnostics.collectionKeys.push(key);
      addCandidates(`WAWebCollections.${key}`, collections[key]);
    }
  } catch (error) { diagnostics.errors.push(`WAWebCollections: ${error.message}`); }

  let moduleNames = [];
  try { moduleNames = Object.keys(window.require('__debug').modulesMap || {}); } catch (error) { diagnostics.errors.push(`__debug: ${error.message}`); }
  if (!moduleNames.length) moduleNames = ['WAWebFavoriteStickerCollection', 'WAWebStickerFavoriteCollection', 'WAWebFavoriteStickersCollection', 'WAWebStickerFavoritesCollection'];
  for (const name of moduleNames) {
    if (!/sticker/i.test(name) || !/fav|starred|saved/i.test(name)) continue;
    diagnostics.modules.push(name);
    try { addCandidates(name, window.require(name)); } catch (error) { diagnostics.errors.push(`${name}: ${error.message}`); }
  }

  diagnostics.candidates = candidates.map(({ name, collection }) => `${name} (${collection.getModelsArray().length})`);
  const chosen = candidates.find(({ name }) => /fav|starred|saved/i.test(name));
  if (!chosen) return { stickers: [], diagnostics };

  const models = chosen.collection.getModelsArray();
  diagnostics.source = chosen.name;
  diagnostics.count = models.length;
  // Só nomes e tipos dos campos (sem valores: a chave de mídia não sai da página).
  const sample = models[0];
  if (sample) for (const key of Object.keys(sample.attributes || sample).slice(0, 60)) diagnostics.sampleFields[key] = typeof (sample.attributes || sample)[key];

  window.__wppapiSavedStickers = new Map();
  const stickers = models.map((model, index) => {
    const id = String(model.id?._serialized ?? model.id ?? model.filehash ?? index);
    window.__wppapiSavedStickers.set(id, model);
    return { id, mimetype: model.mimetype || 'image/webp', isAnimated: Boolean(model.isAnimated) };
  });
  return { stickers, diagnostics };
}

// Roda dentro da página do WhatsApp Web: baixa uma figurinha da lista encontrada acima.
async function downloadSavedStickerInPage(id) {
  const model = window.__wppapiSavedStickers?.get(id);
  if (!model) return { error: 'Figurinha não encontrada. Atualize a lista de figurinhas.' };
  const mimetype = model.mimetype || 'image/webp';
  const toBase64 = (buffer) => window.WWebJS.arrayBufferToBase64Async(buffer);
  const errors = [];
  try {
    const blob = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.get(model.filehash);
    if (blob) return { data: await toBase64(await blob.arrayBuffer()), mimetype };
  } catch (error) { errors.push(`cache: ${error.message}`); }
  try {
    const { downloadManager } = window.require('WAWebDownloadManager');
    const buffer = await downloadManager.downloadAndMaybeDecrypt({
      directPath: model.directPath,
      encFilehash: model.encFilehash,
      filehash: model.filehash,
      mediaKey: model.mediaKey,
      mediaKeyTimestamp: model.mediaKeyTimestamp,
      type: 'sticker',
      signal: new AbortController().signal,
    });
    return { data: await toBase64(buffer), mimetype };
  } catch (error) { errors.push(`downloadManager: ${error.message}`); }
  return { error: `Não foi possível baixar a figurinha (${errors.join(' | ') || 'sem detalhes'}).` };
}

// Lista e baixa figurinhas salvas, guardando as imagens já baixadas.
function createSavedStickers({ getClient, cache }) {
  return {
    async list() {
      return getClient().pupPage.evaluate(findSavedStickersInPage);
    },
    async image(id) {
      const cached = cache.get(id);
      if (cached) return cached;
      const result = await getClient().pupPage.evaluate(downloadSavedStickerInPage, id);
      if (!result?.data) throw new Error(result?.error || 'Não foi possível baixar a figurinha.');
      const entry = { mimetype: result.mimetype, data: result.data, buffer: Buffer.from(result.data, 'base64') };
      cache.set(id, entry);
      return entry;
    },
  };
}

module.exports = { createSavedStickers, findSavedStickersInPage, downloadSavedStickerInPage };
