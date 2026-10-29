const MESSAGE_FETCH_MAX = 2000;

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

// Busca `limit` mensagens anteriores a `beforeId` (ou as mais recentes). A biblioteca só
// carrega a partir do fim da conversa, então amplia a busca até alcançar a mensagem de referência.
async function fetchMessagesPage(chat, limit, beforeId, maxFetch = MESSAGE_FETCH_MAX) {
  let fetchLimit = beforeId ? limit * 2 : limit;
  for (;;) {
    const messages = await chat.fetchMessages({ limit: fetchLimit });
    const reachedStart = messages.length < fetchLimit;
    const end = beforeId ? messages.findIndex((msg) => msg.id?._serialized === beforeId) : messages.length;
    if (end >= 0 && (end >= limit || reachedStart || fetchLimit >= maxFetch)) {
      return { messages: messages.slice(Math.max(0, end - limit), end), hasMore: end > limit || (!reachedStart && fetchLimit < maxFetch) };
    }
    if (reachedStart || fetchLimit >= maxFetch) return { messages: [], hasMore: false };
    fetchLimit = Math.min(fetchLimit * 2, maxFetch);
  }
}

// Completa o autor das mensagens de grupo com o nome salvo do contato ou o número formatado.
function createMessageSerializer({ getClient, contactNames }) {
  async function getContactDisplayName(contactId) {
    if (!contactId) return null;
    let lookup = contactNames.get(contactId);
    if (lookup === undefined) {
      lookup = getClient().getContactById(contactId)
        .then((contact) => contact?.name || contact?.pushname || contact?.shortName || null)
        .catch(() => null);
      contactNames.set(contactId, lookup);
      // Sem nome agora não quer dizer sem nome para sempre: tenta de novo mais cedo.
      lookup.then((name) => { if (!name && contactNames.get(contactId) === lookup) contactNames.set(contactId, lookup, { ttlMs: 5 * 60 * 1000 }); });
    }
    return lookup;
  }

  return async function serializeMessageForChat(msg) {
    const serialized = serializeMessage(msg);
    const authorId = msg.author;
    if (!authorId) return serialized;

    const client = getClient();
    serialized.authorId = authorId;
    let displayName = await getContactDisplayName(authorId);
    let phoneId = authorId.includes('@lid') ? null : authorId;

    if (!displayName && authorId.includes('@lid')) {
      try {
        const [resolved] = await client.getContactLidAndPhone([authorId]);
        phoneId = resolved?.pn || null;
        if (phoneId) displayName = await getContactDisplayName(phoneId);
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
  };
}

module.exports = { serializeMessage, fetchMessagesPage, createMessageSerializer, MESSAGE_FETCH_MAX };
