// Cache em memória com validade e limite de itens/bytes; descarta primeiro os usados há mais tempo.
function createCache({ maxEntries = Infinity, maxBytes = Infinity, sizeOf = () => 0, ttlMs = Infinity, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.size;
    return true;
  }

  return {
    // `undefined` significa ausente; `null` é um valor válido (ex.: contato sem foto).
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        remove(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, { ttlMs: entryTtlMs = ttlMs, expiresAt } = {}) {
      remove(key);
      const size = sizeOf(value);
      entries.set(key, { value, size, expiresAt: expiresAt ?? now() + entryTtlMs });
      bytes += size;
      while (entries.size && (entries.size > maxEntries || bytes > maxBytes)) remove(entries.keys().next().value);
    },
    delete: remove,
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
}

module.exports = { createCache };
