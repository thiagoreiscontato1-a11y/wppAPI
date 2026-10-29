const PROFILE_PICTURE_TTL_MS = 60 * 60 * 1000;
const PROFILE_PICTURE_MISS_TTL_MS = 10 * 60 * 1000;
// Tipos que o navegador pode abrir sem risco de executar scripts na origem do chat.
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/;
// Formatos que o WhatsApp mostra direto na conversa; o resto vai como documento.
const PLAYABLE_UPLOAD_TYPES = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|x-m4a|opus))$/;

// Os links de foto do WhatsApp expiram (parâmetro hexadecimal `oe`); renova antes disso.
function profilePictureExpiry(url, now = Date.now()) {
  if (!url) return now + PROFILE_PICTURE_MISS_TTL_MS;
  let expiresAt = now + PROFILE_PICTURE_TTL_MS;
  try {
    const oe = parseInt(new URL(url).searchParams.get('oe'), 16);
    if (Number.isFinite(oe)) expiresAt = Math.min(expiresAt, oe * 1000 - 5 * 60 * 1000);
  } catch {}
  return Math.max(expiresAt, now + 60 * 1000);
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : { invalid: true };
}

// Arquivos recebidos podem ser HTML ou SVG com scripts: só tipos seguros abrem no navegador,
// os demais são baixados, e nada servido daqui roda scripts na origem do chat.
function mediaResponseHeaders({ mimetype, filename }) {
  const name = filename || 'arquivo';
  const safeName = name.replace(/[\r\n"\\]/g, '_');
  const headers = {
    'Content-Type': mimetype,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `${INLINE_TYPES.test(mimetype) ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  if (mimetype !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  return headers;
}

function isPlayableUpload(mimetype) {
  return PLAYABLE_UPLOAD_TYPES.test(mimetype);
}

module.exports = { profilePictureExpiry, parseByteRange, mediaResponseHeaders, isPlayableUpload };
