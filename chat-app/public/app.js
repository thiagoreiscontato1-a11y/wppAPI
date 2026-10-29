const socket = io();
const $ = (id) => document.getElementById(id);
const els = {
  overlay: $('connectOverlay'), title: $('connectTitle'), text: $('connectText'), qrWrap: $('qrWrap'), qr: $('qrImage'),
  spinner: $('connectSpinner'), error: $('connectError'), retry: $('retryBtn'), chatList: $('chatList'), search: $('searchInput'),
  empty: $('emptyState'), thread: $('thread'), app: $('app'), messages: $('messages'),
  name: $('threadName'), meta: $('threadMeta'), avatar: $('threadAvatar'), input: $('messageInput'), composer: $('composer'),
  replyBar: $('replyBar'), replyAuthor: $('replyAuthor'), replyText: $('replyText'), stickerInput: $('stickerInput'),
};
els.mediaInput = $('mediaInput');
let statusState = 'starting';
let chats = [];
let activeChat = null;
let replyTarget = null;
let renderedIds = new Set();
const profilePictureCache = new Map();
const profilePicturePending = new Set();
const profilePictureRefresh = new Set();
const profilePictureRetried = new Set();
const PROFILE_PICTURE_TTL_MS = 30 * 60 * 1000;
const messageAcks = new Map();
const pendingNewChatMessages = [];
let chatsReloadTimer;
const FIRST_PAGE_SIZE = 80;
const OLDER_PAGE_SIZE = 50;
let threadHasMore = false;
let loadingOlder = false;
let myName = '';
let maxUploadBytes = 32 * 1024 * 1024;
const profilePictureQueue = [];
let profilePictureActive = 0;
let profileObserver;
let renderChatsFrame = 0;
const chatRows = new Map();
const PROFILE_PICTURE_CACHE_MAX = 2000;
let toastTimer;
let noticeTimer;
let notificationAudioContext = null;
let lastNotificationSoundAt = 0;
let notificationSoundEnabled = true;
let inAppNotificationsEnabled = true;
let desktopNotificationsEnabled = false;
let mutedChats = new Set();
let chatFilter = 'all';

try { notificationSoundEnabled = localStorage.getItem('wppapi-chat-sound') !== 'off'; } catch {}
try { inAppNotificationsEnabled = localStorage.getItem('wppapi-chat-inapp') !== 'off'; } catch {}
try { desktopNotificationsEnabled = localStorage.getItem('wppapi-chat-desktop') === 'on'; } catch {}
try { mutedChats = new Set(JSON.parse(localStorage.getItem('wppapi-chat-muted') || '[]')); } catch {}

// theme.js já aplicou o tema salvo (ou o do sistema) antes da página aparecer.
function setTheme(theme, persist = true) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeToggle').checked = dark;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0c201c' : '#10302a';
  if (persist) {
    try { localStorage.setItem('wppapi-chat-theme', dark ? 'dark' : 'light'); } catch {}
  }
}
setTheme(document.documentElement.dataset.theme, false);

function iconHtml(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
// Cor estável por contato, para avatares e nomes em grupos.
function toneFor(id = '') {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `tone-${hash % 6}`;
}

function updateSoundToggle() {
  $('soundToggle').checked = notificationSoundEnabled;
}
function unlockNotificationAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    notificationAudioContext ||= new AudioContextClass();
    if (notificationAudioContext.state === 'suspended') notificationAudioContext.resume().catch(() => {});
  } catch {}
}
function playNotificationSound() {
  if (!notificationSoundEnabled || !notificationAudioContext || notificationAudioContext.state !== 'running') return;
  const nowMs = Date.now();
  if (nowMs - lastNotificationSoundAt < 2200) return;
  lastNotificationSoundAt = nowMs;
  const context = notificationAudioContext;
  const start = context.currentTime;
  [660, 880].forEach((frequency, index) => {
    const at = start + index * 0.09;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.035, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.14);
  });
}
updateSoundToggle();
document.addEventListener('pointerdown', unlockNotificationAudio, { once: true });
document.addEventListener('keydown', unlockNotificationAudio, { once: true });

function showMessageNotification(chat, message) {
  if (!inAppNotificationsEnabled) return;
  const notice = $('messageNotice');
  $('noticeTitle').textContent = chat?.name || 'Nova mensagem';
  $('noticeBody').textContent = messagePreview(message);
  notice.dataset.chatId = chat?.id || '';
  notice.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add('hidden'), 4800);
}
function updateNotificationSettings() {
  $('inAppNotificationsToggle').checked = inAppNotificationsEnabled;
  $('desktopNotificationsToggle').checked = desktopNotificationsEnabled;
  $('desktopNotificationsToggle').disabled = !('Notification' in window);
  $('desktopNotificationHelp').textContent = !('Notification' in window) ? 'Este navegador não oferece notificações do sistema.' : Notification.permission === 'denied' ? 'Notificações bloqueadas nas permissões do navegador.' : 'O navegador pode pedir autorização para mostrar notificações.';
}
function updateMuteButton() {
  if (!activeChat) return;
  const muted = mutedChats.has(activeChat.id);
  const button = $('muteChatBtn');
  button.innerHTML = iconHtml(muted ? 'bell-off' : 'bell');
  button.title = muted ? 'Ativar notificações desta conversa' : 'Silenciar conversa';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(muted));
}

// Iniciais do nome; para um número de telefone sem nome salvo, os dois últimos dígitos.
function initials(text = '?') {
  const words = text.trim().split(/\s+/).filter((part) => /\p{L}/u.test(part));
  if (!words.length) return text.replace(/\D/g, '').slice(-2) || '?';
  return words.slice(0, 2).map((part) => part.match(/\p{L}/u)[0]).join('').toUpperCase();
}
function escapeHtml(text = '') { return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function showToast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
function applyPictureToSlot(slot, url) {
  const chatId = slot.dataset.profileId;
  slot.querySelector('img')?.remove();
  slot.classList.remove('has-photo');
  if (!url) return;
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.onload = () => slot.classList.add('has-photo');
  img.onerror = () => { img.remove(); refreshExpiredProfilePicture(chatId); };
  slot.appendChild(img);
}
function applyProfilePicture(chatId, url) {
  document.querySelectorAll('.profile-picture-slot').forEach((slot) => {
    if (slot.dataset.profileId === chatId) applyPictureToSlot(slot, url);
  });
}
function rememberProfilePicture(chatId, url) {
  profilePictureCache.delete(chatId);
  profilePictureCache.set(chatId, { url, at: Date.now() });
  if (profilePictureCache.size > PROFILE_PICTURE_CACHE_MAX) profilePictureCache.delete(profilePictureCache.keys().next().value);
}
function cachedProfilePicture(chatId) {
  const cached = profilePictureCache.get(chatId);
  if (!cached || Date.now() - cached.at > PROFILE_PICTURE_TTL_MS) return undefined;
  return cached.url;
}
// O link da foto pode ter expirado: pede um novo ao servidor uma única vez por contato.
function refreshExpiredProfilePicture(chatId) {
  if (profilePictureRetried.has(chatId)) return;
  profilePictureRetried.add(chatId);
  profilePictureCache.delete(chatId);
  profilePictureRefresh.add(chatId);
  queueProfilePicture(chatId);
}
function queueProfilePicture(chatId) {
  const cached = cachedProfilePicture(chatId);
  if (cached !== undefined) { applyProfilePicture(chatId, cached); return; }
  if (profilePicturePending.has(chatId)) return;
  profilePicturePending.add(chatId);
  profilePictureQueue.push(chatId);
  processProfilePictureQueue();
}
function processProfilePictureQueue() {
  while (profilePictureActive < 2 && profilePictureQueue.length) {
    const chatId = profilePictureQueue.shift();
    const refresh = profilePictureRefresh.delete(chatId);
    profilePictureActive += 1;
    api(`/api/chats/${encodeURIComponent(chatId)}/profile-picture${refresh ? '?refresh=1' : ''}`)
      .then(({ url }) => { rememberProfilePicture(chatId, url || null); applyProfilePicture(chatId, url || null); })
      .catch(() => { rememberProfilePicture(chatId, null); })
      .finally(() => { profilePicturePending.delete(chatId); profilePictureActive -= 1; processProfilePictureQueue(); });
  }
}
function messagePreview(message) {
  if (message.body) return message.body;
  if (!message.hasMedia) return 'Mensagem';
  return ({ sticker: 'Figurinha', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', ptt: 'Mensagem de voz', document: 'Documento' })[message.type] || 'Mídia anexada';
}
function messageTypeLabel(type = '') {
  return ({
    call_log: 'Chamada de voz',
    call: 'Chamada',
    missed_call: 'Chamada perdida',
    video_call: 'Chamada de vídeo',
    e2e_notification: 'Notificação do WhatsApp',
    notification_template: 'Aviso do WhatsApp',
    revoked: 'Mensagem apagada',
    protocol: 'Atualização da conversa',
    ciphertext: 'Mensagem indisponível',
    gp2: 'Atualização do grupo',
    unknown: 'Mensagem não disponível',
  })[type] || (type ? type.replaceAll('_', ' ') : 'Mensagem');
}
function setReplyTarget(message) {
  replyTarget = message;
  els.replyAuthor.textContent = message.fromMe ? 'Você' : (message.author || activeChat?.name || 'Mensagem');
  els.replyText.textContent = messagePreview(message);
  els.replyBar.classList.remove('hidden');
  els.input.focus();
}
function clearReplyTarget() {
  replyTarget = null;
  els.replyBar.classList.add('hidden');
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não consegui ler a imagem selecionada.'));
    reader.readAsDataURL(file);
  });
}
function displayStatus(data) {
  statusState = data.state;
  if (Number.isFinite(data.maxUploadBytes)) maxUploadBytes = data.maxUploadBytes;
  $('sessionLogoutBtn').classList.toggle('hidden', !data.authEnabled);
  if (data.me) {
    myName = data.me.name || '';
    const avatar = document.querySelector('.me-avatar');
    avatar.textContent = initials(myName || 'Você');
    $('meName').textContent = myName || 'Você';
  }
  const connected = data.state === 'ready';
  $('sidebarStatus').textContent = connected ? 'WhatsApp conectado' : data.state === 'qr' ? 'Aguardando o QR code' : data.state === 'authenticated' ? 'Sincronizando conversas' : 'Conectando ao WhatsApp';
  $('sidebarDot').classList.toggle('ready', connected);
  if (connected) { els.overlay.classList.add('hidden'); loadChats(); return; }
  els.overlay.classList.remove('hidden');
  els.qrWrap.classList.toggle('hidden', !data.qrDataUrl);
  els.qr.src = data.qrDataUrl || '';
  els.spinner.classList.toggle('hidden', Boolean(data.qrDataUrl) || data.state === 'error');
  els.retry.classList.toggle('hidden', data.state !== 'error' && data.state !== 'disconnected');
  els.error.classList.toggle('hidden', !data.error);
  els.error.textContent = data.error || '';
  if (data.state === 'qr') { els.title.textContent = 'Conecte seu WhatsApp'; els.text.textContent = 'Leia o QR code com o celular que vai ficar conectado a este servidor.'; }
  else if (data.state === 'authenticated') {
    els.title.textContent = 'Celular conectado';
    els.text.textContent = Number.isFinite(data.loadingPercent) ? `Sincronizando conversas… ${data.loadingPercent}%` : 'WhatsApp autenticado. Aguardando a sincronização inicial…';
  }
  else if (data.state === 'disconnected') { els.title.textContent = 'Conexão perdida'; els.text.textContent = 'Tentando reconectar automaticamente. Se demorar, toque em Tentar novamente.'; }
  else if (data.state === 'error') { els.title.textContent = 'Não foi possível conectar'; els.text.textContent = 'Confira a sessão do WhatsApp e tente iniciar novamente.'; }
  else { els.title.textContent = 'Conectando ao WhatsApp'; els.text.textContent = 'Iniciando a conexão com o WhatsApp…'; }
}
socket.on('status', displayStatus);
function notifyIncomingMessage(chat, message) {
  if (message.fromMe || mutedChats.has(chat.id)) return;
  showMessageNotification(chat, message);
  playNotificationSound();
  if (desktopNotificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(chat.name || 'Nova mensagem', { body: messagePreview(message), tag: `wppapi-${chat.id}` });
    notification.onclick = () => { window.focus(); openChat(chat.id); notification.close(); };
  }
}
// Mensagem de uma conversa que ainda não está na lista: recarrega a lista e então notifica.
function reloadChatsForNewMessage(chatId, message) {
  pendingNewChatMessages.push({ chatId, message });
  clearTimeout(chatsReloadTimer);
  chatsReloadTimer = setTimeout(async () => {
    const pending = pendingNewChatMessages.splice(0);
    await loadChats();
    pending.forEach((item) => {
      const chat = chats.find((entry) => entry.id === item.chatId);
      if (chat) notifyIncomingMessage(chat, item.message);
    });
  }, 500);
}
function markChatSeen(chatId) {
  api(`/api/chats/${encodeURIComponent(chatId)}/seen`, { method: 'POST' }).catch(() => {});
}
socket.on('message', ({ chatId, message }) => {
  if (activeChat?.id === chatId) appendMessage(message);
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) { reloadChatsForNewMessage(chatId, message); return; }
  const isVisibleConversation = activeChat?.id === chatId && !document.hidden;
  if (!message.fromMe && !isVisibleConversation) chat.unreadCount = (chat.unreadCount || 0) + 1;
  if (!message.fromMe && isVisibleConversation) markChatSeen(chatId);
  chat.lastMessage = messagePreview(message);
  chat.timestamp = Math.max(chat.timestamp || 0, message.timestamp || 0);
  scheduleRenderChats();
  if (!isVisibleConversation) notifyIncomingMessage(chat, message);
});
socket.on('ack', ({ id, ack }) => {
  if (!id) return;
  const value = mergeAck(messageAcks.get(id), ack);
  messageAcks.set(id, value);
  const status = els.messages.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"] .message-status`);
  if (status) applyAckStatus(status, value);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !activeChat?.unreadCount) return;
  activeChat.unreadCount = 0;
  markChatSeen(activeChat.id);
  renderChats();
});
// A sessão pode ter expirado: api() leva para a tela de login nesse caso.
socket.on('connect_error', () => { showToast('Reconectando ao servidor…'); api('/api/status').catch(() => {}); });

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.login) { location.replace('/login.html'); throw new Error(data.error); }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
  return data;
}
function timeLabel(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
// A lista reaproveita uma linha por conversa e só redesenha o que mudou; assim uma mensagem
// nova atualiza uma linha e a move para o topo, em vez de recriar a lista inteira.
function chatAvatarHtml(chat) {
  return `<span class="avatar chat-avatar profile-picture-slot ${toneFor(chat.id)} ${chat.isGroup ? 'group' : ''}" data-profile-id="${escapeHtml(chat.id)}" aria-hidden="true"><span class="avatar-initials">${escapeHtml(initials(chat.name))}</span></span>`;
}
function chatCopyHtml(chat) {
  const muted = mutedChats.has(chat.id) ? `<svg class="icon chat-muted" aria-label="Silenciada"><use href="#i-bell-off"/></svg>` : '';
  return `<span class="chat-line"><span class="chat-name">${escapeHtml(chat.name)}</span><span class="chat-time">${timeLabel(chat.timestamp)}</span></span><span class="chat-line"><span class="chat-preview">${escapeHtml(chat.lastMessage || (chat.isGroup ? 'Grupo' : chat.number))}</span>${muted}${chat.unreadCount ? `<span class="unread" aria-label="${chat.unreadCount} não lidas">${chat.unreadCount}</span>` : ''}</span>`;
}
function chatRowFor(chat) {
  let entry = chatRows.get(chat.id);
  if (!entry) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row';
    row.dataset.id = chat.id;
    row.innerHTML = '<span class="chat-copy"></span>';
    row.addEventListener('click', () => openChat(chat.id));
    entry = { row, avatarHtml: '', copyHtml: '' };
    chatRows.set(chat.id, entry);
  }
  const avatarHtml = chatAvatarHtml(chat);
  if (entry.avatarHtml !== avatarHtml) {
    entry.row.querySelector('.chat-avatar')?.remove();
    entry.row.insertAdjacentHTML('afterbegin', avatarHtml);
    entry.avatarHtml = avatarHtml;
    const slot = entry.row.querySelector('.chat-avatar');
    const cached = cachedProfilePicture(chat.id);
    if (cached !== undefined) applyPictureToSlot(slot, cached);
    else profileObserver.observe(slot);
  }
  const copyHtml = chatCopyHtml(chat);
  if (entry.copyHtml !== copyHtml) {
    entry.row.querySelector('.chat-copy').innerHTML = copyHtml;
    entry.copyHtml = copyHtml;
  }
  entry.row.classList.toggle('selected', activeChat?.id === chat.id);
  entry.row.classList.toggle('has-unread', Boolean(chat.unreadCount));
  if (activeChat?.id === chat.id) entry.row.setAttribute('aria-current', 'true'); else entry.row.removeAttribute('aria-current');
  return entry.row;
}
function renderChats() {
  cancelAnimationFrame(renderChatsFrame);
  renderChatsFrame = 0;
  profileObserver ||= new IntersectionObserver((items) => {
    items.forEach((item) => {
      if (!item.isIntersecting) return;
      profileObserver.unobserve(item.target);
      queueProfilePicture(item.target.dataset.profileId);
    });
  }, { root: els.chatList, rootMargin: '80px' });
  const query = els.search.value.trim().toLocaleLowerCase('pt-BR');
  const shown = chats
    .filter((chat) => chatFilter !== 'unread' || chat.unreadCount)
    .filter((chat) => chatFilter !== 'groups' || chat.isGroup)
    .filter((chat) => `${chat.name} ${chat.number} ${chat.lastMessage}`.toLocaleLowerCase('pt-BR').includes(query))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (!shown.length) {
    const note = query ? 'Nenhuma conversa encontrada para essa busca.' : chatFilter === 'unread' ? 'Tudo lido por aqui.' : chatFilter === 'groups' ? 'Nenhum grupo nesta conta.' : 'Nenhuma conversa ainda.';
    els.chatList.innerHTML = `<div class="list-note">${note}</div>`;
    return;
  }
  els.chatList.querySelector('.list-note')?.remove();
  // Percorre a lista na ordem desejada, movendo só as linhas que estão fora do lugar.
  let cursor = els.chatList.firstElementChild;
  shown.forEach((chat) => {
    const row = chatRowFor(chat);
    if (row === cursor) cursor = cursor.nextElementSibling;
    else els.chatList.insertBefore(row, cursor);
  });
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}
// Junta várias atualizações seguidas (rajada de mensagens) em um único redesenho por quadro.
function scheduleRenderChats() {
  if (!renderChatsFrame) renderChatsFrame = requestAnimationFrame(renderChats);
}
async function loadChats() {
  if (statusState !== 'ready') return;
  try {
    chats = await api('/api/chats');
    if (activeChat) activeChat = chats.find((chat) => chat.id === activeChat.id) || activeChat;
    const ids = new Set(chats.map((chat) => chat.id));
    for (const id of chatRows.keys()) if (!ids.has(id)) chatRows.delete(id);
    renderChats();
  }
  catch (error) { els.chatList.innerHTML = `<div class="list-note">${escapeHtml(error.message)}</div>`; }
}
function dayLabel(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Hoje';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
// Confirmações só avançam (pendente → enviada → entregue → lida); -1 indica falha no envio.
function mergeAck(previous, next) {
  if (!Number.isInteger(next)) return previous ?? null;
  if (next === -1 || !Number.isInteger(previous)) return next;
  return Math.max(previous, next);
}
function applyAckStatus(element, ack) {
  const [icon, label, variant] = ack === -1 ? ['alert', 'Falha no envio', 'failed']
    : ack === 0 ? ['clock', 'Enviando', 'pending']
    : ack >= 3 ? ['check-check', 'Lida', 'read']
    : ack === 2 ? ['check-check', 'Entregue', 'delivered']
    : ['check', 'Enviada', 'sent'];
  element.innerHTML = iconHtml(icon);
  element.title = label;
  element.setAttribute('aria-label', label);
  element.className = `message-status ${variant}`;
}
function messageTime(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
}
function isNearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
}
function createMessageRow(message) {
  const time = messageTime(message.timestamp);
  const mediaUrl = message.hasMedia && message.id ? `/api/media/${encodeURIComponent(message.id)}` : '';
  let attachment = '';
  if (mediaUrl && message.isGif) attachment = `<video class="inline-video inline-gif" src="${mediaUrl}" autoplay loop muted playsinline></video>`;
  else if (mediaUrl && message.type === 'sticker') attachment = `<a class="media-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="inline-sticker" src="${mediaUrl}" alt="Figurinha" loading="lazy" /></a>`;
  else if (mediaUrl && message.type === 'image') attachment = `<a class="media-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="inline-image" src="${mediaUrl}" alt="${message.fromMe ? 'Imagem enviada' : 'Imagem recebida'}" loading="lazy" /></a>`;
  else if (mediaUrl && message.type === 'video') attachment = `<video class="inline-video" src="${mediaUrl}" controls preload="none"></video>`;
  else if (mediaUrl && ['audio', 'ptt'].includes(message.type)) attachment = `<audio class="inline-audio" src="${mediaUrl}" controls preload="none"></audio>`;
  else if (mediaUrl && message.type === 'document') attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener" download="${escapeHtml(message.filename || '')}">${iconHtml('file')}<span>${escapeHtml(message.filename || 'Abrir ou baixar documento')}</span></a>`;
  else if (message.hasMedia) attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener">${iconHtml('file')}<span>Abrir mídia (${escapeHtml(message.type || 'arquivo')})</span></a>`;
  const caption = message.type === 'document' && message.body === message.filename ? '' : message.body;
  const text = caption ? `<span class="message-text">${escapeHtml(caption)}</span>` : (!attachment ? `<span class="message-text message-system">${escapeHtml(messageTypeLabel(message.type))}</span>` : '');
  const quote = message.replyPreview || message.quotedMessage;
  const quoteText = quote ? (quote.body || (quote.hasMedia ? messagePreview(quote) : 'Mensagem')) : '';
  const quoteHtml = quote ? `<div class="quoted-message"><strong>${escapeHtml(quote.fromMe ? 'Você' : (quote.author || 'Mensagem citada'))}</strong><span>${escapeHtml(quoteText)}</span></div>` : '';
  const row = document.createElement('div');
  row.className = `message-row ${message.fromMe ? 'mine' : ''}`;
  if (message.id) row.dataset.messageId = message.id;
  row.dataset.timestamp = String(message.timestamp || '');
  // Em grupos, as mensagens de outras pessoas levam avatar e nome; seguidas da mesma pessoa, só o balão.
  const inGroup = !message.fromMe && activeChat?.isGroup;
  const senderId = message.fromMe ? 'me' : (message.authorId || 'them');
  row.dataset.sender = senderId;
  const senderName = message.fromMe ? 'Você' : inGroup
    ? (message.author || (message.authorId ? message.authorId.split('@')[0].replace(/:\d+$/, '') : 'Participante'))
    : (message.author || activeChat?.name || '');
  const avatar = inGroup ? `<span class="avatar avatar-sm ${toneFor(senderId)} ${message.authorId ? 'profile-picture-slot' : ''}" ${message.authorId ? `data-profile-id="${escapeHtml(message.authorId)}"` : ''} aria-hidden="true"><span class="avatar-initials">${escapeHtml(initials(senderName))}</span></span>` : '';
  const name = inGroup ? `<span class="sender-name ${toneFor(senderId)}">${escapeHtml(senderName)}</span>` : '';
  row.innerHTML = `${avatar}<div class="message-content"><div class="message-bubble">${name}${quoteHtml}${attachment}<div class="message-body">${text}<span class="message-meta">${time}${message.fromMe ? '<span class="message-status"></span>' : ''}</span></div></div></div><div class="message-actions"><button class="icon-button reply-message-button" type="button" title="Responder" aria-label="Responder a esta mensagem">${iconHtml('reply')}</button></div>`;
  row.querySelector('.reply-message-button').addEventListener('click', () => setReplyTarget(message));
  if (message.fromMe) {
    const ack = mergeAck(messageAcks.get(message.id), message.ack);
    if (message.id) messageAcks.set(message.id, ack);
    applyAckStatus(row.querySelector('.message-status'), ack);
  }
  return row;
}
function queueRowProfilePictures(root) {
  root.querySelectorAll('.message-row .profile-picture-slot').forEach((slot) => queueProfilePicture(slot.dataset.profileId));
}
const GROUP_WINDOW_SECONDS = 5 * 60;
// Recria os separadores de dia e o agrupamento a partir das mensagens exibidas (vale para histórico e tempo real).
function refreshDayDividers() {
  els.messages.querySelectorAll('.day-divider').forEach((divider) => divider.remove());
  let priorDay = '';
  let prior = null;
  els.messages.querySelectorAll('.message-row').forEach((row) => {
    const timestamp = Number(row.dataset.timestamp);
    const day = timestamp ? dayLabel(timestamp) : priorDay;
    if (day !== priorDay) {
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.innerHTML = `<span>${escapeHtml(day)}</span>`;
      row.before(divider);
      priorDay = day;
      prior = null;
    }
    const continued = Boolean(prior) && prior.sender === row.dataset.sender && timestamp - prior.timestamp < GROUP_WINDOW_SECONDS;
    row.classList.toggle('continued', continued);
    prior = { sender: row.dataset.sender, timestamp };
  });
}
function appendMessage(message) {
  if (message.id && renderedIds.has(message.id)) return;
  if (message.id) renderedIds.add(message.id);
  const shouldScroll = message.fromMe || isNearBottom();
  const row = createMessageRow(message);
  els.messages.appendChild(row);
  queueRowProfilePictures(row);
  refreshDayDividers();
  updateHistoryLoader();
  if (shouldScroll) els.messages.scrollTop = els.messages.scrollHeight;
}
function updateHistoryLoader() {
  const loader = els.messages.querySelector('.history-loader');
  if (!loader) return;
  const hasRows = Boolean(els.messages.querySelector('.message-row'));
  loader.classList.toggle('hidden', !hasRows);
  const button = loader.querySelector('button');
  button.disabled = loadingOlder || !threadHasMore;
  button.textContent = loadingOlder ? 'Carregando mensagens anteriores…' : threadHasMore ? 'Carregar mensagens anteriores' : 'Início da conversa';
}
async function loadOlderMessages() {
  if (!activeChat || loadingOlder || !threadHasMore) return;
  const firstRow = els.messages.querySelector('.message-row[data-message-id]');
  if (!firstRow) return;
  const chatId = activeChat.id;
  loadingOlder = true; updateHistoryLoader();
  try {
    const page = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${OLDER_PAGE_SIZE}&before=${encodeURIComponent(firstRow.dataset.messageId)}`);
    if (activeChat?.id !== chatId) return;
    threadHasMore = page.hasMore;
    const previousHeight = els.messages.scrollHeight;
    const previousTop = els.messages.scrollTop;
    const fragment = document.createDocumentFragment();
    page.messages.forEach((message) => {
      if (message.id && renderedIds.has(message.id)) return;
      if (message.id) renderedIds.add(message.id);
      fragment.appendChild(createMessageRow(message));
    });
    const anchor = firstRow.previousElementSibling?.classList.contains('day-divider') ? firstRow.previousElementSibling : firstRow;
    anchor.before(fragment);
    refreshDayDividers();
    queueRowProfilePictures(els.messages);
    els.messages.scrollTop = previousTop + (els.messages.scrollHeight - previousHeight);
  } catch (error) { if (activeChat?.id === chatId) showToast(error.message); }
  finally {
    if (activeChat?.id === chatId) { loadingOlder = false; updateHistoryLoader(); }
  }
}
async function openChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  activeChat = chat; renderedIds = new Set();
  messageAcks.clear();
  threadHasMore = false; loadingOlder = false;
  clearReplyTarget();
  els.name.textContent = chat.name;
  updateMuteButton();
  els.meta.textContent = chat.isGroup ? 'Grupo' : chat.number;
  els.input.placeholder = `Mensagem para ${chat.name}`;
  els.avatar.innerHTML = `<span class="avatar-initials">${escapeHtml(initials(chat.name))}</span>`;
  els.avatar.dataset.profileId = chat.id;
  els.avatar.className = `avatar avatar-md profile-picture-slot ${toneFor(chat.id)} ${chat.isGroup ? 'group' : ''}`;
  queueProfilePicture(chat.id);
  els.empty.classList.add('hidden'); els.thread.classList.remove('hidden');
  // No celular a conversa ocupa a tela; o botão voltar do navegador (ou do Android) retorna à lista.
  if (!els.app.classList.contains('thread-open')) history.pushState({ thread: true }, '');
  els.app.classList.add('thread-open');
  renderChats();
  els.messages.innerHTML = '<div class="list-note">Carregando mensagens…</div>';
  try {
    const page = await api(`/api/chats/${encodeURIComponent(id)}/messages?limit=${FIRST_PAGE_SIZE}`);
    if (activeChat?.id !== id) return;
    threadHasMore = page.hasMore;
    // Mensagens que chegaram durante o carregamento estavam no indicador de carregamento; o histórico as inclui.
    renderedIds = new Set();
    els.messages.innerHTML = '<div class="history-loader hidden"><button type="button"></button></div>';
    els.messages.querySelector('.history-loader button').addEventListener('click', loadOlderMessages);
    const fragment = document.createDocumentFragment();
    page.messages.forEach((message) => {
      if (message.id && renderedIds.has(message.id)) return;
      if (message.id) renderedIds.add(message.id);
      fragment.appendChild(createMessageRow(message));
    });
    els.messages.appendChild(fragment);
    refreshDayDividers();
    queueRowProfilePictures(els.messages);
    updateHistoryLoader();
    els.messages.scrollTop = els.messages.scrollHeight;
    chat.unreadCount = 0; renderChats();
    markChatSeen(id);
  } catch (error) { if (activeChat?.id === id) els.messages.innerHTML = `<div class="list-note">${escapeHtml(error.message)}</div>`; }
  // No celular, focar a caixa abriria o teclado por cima das mensagens.
  if (!isSinglePane()) els.input.focus();
}
function isSinglePane() { return window.matchMedia('(max-width: 760px)').matches; }
// Volta para a lista (usado no celular). A conversa continua selecionada na barra lateral.
function showChatList() {
  els.app.classList.remove('thread-open');
  els.chatList.querySelector('.chat-row.selected')?.focus();
}
$('backBtn').addEventListener('click', () => { if (history.state?.thread) history.back(); else showChatList(); });
window.addEventListener('popstate', () => { if (els.app.classList.contains('thread-open')) showChatList(); });
els.messages.addEventListener('scroll', () => { if (els.messages.scrollTop < 80) loadOlderMessages(); });
els.search.addEventListener('input', renderChats);
$('refreshBtn').addEventListener('click', loadChats);
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  chatFilter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  renderChats();
}));
$('themeToggle').addEventListener('change', (event) => setTheme(event.currentTarget.checked ? 'dark' : 'light'));
$('soundToggle').addEventListener('change', (event) => {
  notificationSoundEnabled = event.currentTarget.checked;
  try { localStorage.setItem('wppapi-chat-sound', notificationSoundEnabled ? 'on' : 'off'); } catch {}
  if (notificationSoundEnabled) unlockNotificationAudio();
});
function setSettingsOpen(open) {
  $('settingsMenu').classList.toggle('hidden', !open);
  $('settingsBtn').setAttribute('aria-expanded', String(open));
  if (open) updateNotificationSettings();
}
$('settingsBtn').addEventListener('click', () => setSettingsOpen($('settingsMenu').classList.contains('hidden')));
document.addEventListener('click', (event) => {
  if (!event.target.closest('#settingsMenu, #settingsBtn')) setSettingsOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('settingsMenu').classList.contains('hidden')) return;
  setSettingsOpen(false);
  $('settingsBtn').focus();
});
$('inAppNotificationsToggle').addEventListener('change', (event) => {
  inAppNotificationsEnabled = event.currentTarget.checked;
  try { localStorage.setItem('wppapi-chat-inapp', inAppNotificationsEnabled ? 'on' : 'off'); } catch {}
  if (!inAppNotificationsEnabled) $('messageNotice').classList.add('hidden');
});
$('desktopNotificationsToggle').addEventListener('change', async (event) => {
  if (!event.currentTarget.checked) desktopNotificationsEnabled = false;
  else if ('Notification' in window) {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    desktopNotificationsEnabled = permission === 'granted';
    if (!desktopNotificationsEnabled) showToast('Permita notificações nas configurações do navegador.');
  }
  event.currentTarget.checked = desktopNotificationsEnabled;
  try { localStorage.setItem('wppapi-chat-desktop', desktopNotificationsEnabled ? 'on' : 'off'); } catch {}
  updateNotificationSettings();
});
$('muteChatBtn').addEventListener('click', () => {
  if (!activeChat) return;
  if (mutedChats.has(activeChat.id)) mutedChats.delete(activeChat.id); else mutedChats.add(activeChat.id);
  try { localStorage.setItem('wppapi-chat-muted', JSON.stringify([...mutedChats])); } catch {}
  updateMuteButton(); renderChats();
  showToast(mutedChats.has(activeChat.id) ? 'Conversa silenciada.' : 'Notificações da conversa ativadas.');
});
$('messageNotice').addEventListener('click', (event) => {
  if (event.target.id === 'dismissNotice') return;
  const chatId = event.currentTarget.dataset.chatId;
  event.currentTarget.classList.add('hidden');
  if (chatId) openChat(chatId);
});
$('dismissNotice').addEventListener('click', (event) => { event.stopPropagation(); $('messageNotice').classList.add('hidden'); });
$('messageNotice').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    const chatId = event.currentTarget.dataset.chatId;
    event.currentTarget.classList.add('hidden');
    if (chatId) openChat(chatId);
  }
});
$('logoutBtn').addEventListener('click', async () => { if (!confirm('Desconectar o WhatsApp deste servidor? Para usar de novo, será preciso ler o QR code.')) return; try { await api('/api/logout', { method: 'POST' }); } catch (error) { showToast(error.message); } });
$('sessionLogoutBtn').addEventListener('click', async () => {
  try { await api('/api/session/logout', { method: 'POST' }); } catch {}
  location.replace('/login.html');
});
$('retryBtn').addEventListener('click', async () => {
  els.retry.classList.add('hidden');
  els.spinner.classList.remove('hidden');
  try { await api('/api/restart', { method: 'POST' }); } catch (error) { showToast(error.message); els.retry.classList.remove('hidden'); }
});
$('cancelReplyBtn').addEventListener('click', clearReplyTarget);
$('stickerBtn').addEventListener('click', () => els.stickerInput.click());
$('mediaBtn').addEventListener('click', () => els.mediaInput.click());
async function sendFile(file) {
  if (!activeChat) { showToast('Abra uma conversa antes de anexar um arquivo.'); return; }
  if (file.type === 'image/gif') { await sendClipboardMedia(file); return; }
  if (!file.size) { showToast('O arquivo está vazio.'); return; }
  if (file.size > maxUploadBytes) { showToast(`O arquivo deve ter até ${Math.round(maxUploadBytes / 1024 / 1024)} MB.`); return; }
  const chatId = activeChat.id;
  const quoted = replyTarget;
  const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'arquivo') };
  if (quoted?.id) headers['X-Quoted-Message-Id'] = quoted.id;
  try {
    showToast(`Enviando ${file.name || 'arquivo'}…`);
    const sent = await api(`/api/chats/${encodeURIComponent(chatId)}/files`, { method: 'POST', headers, body: file });
    if (quoted) sent.replyPreview = { id: quoted.id, body: messagePreview(quoted), fromMe: quoted.fromMe };
    if (activeChat?.id === chatId) appendMessage(sent);
    if (replyTarget === quoted) clearReplyTarget();
  } catch (error) { showToast(error.message); }
}
async function sendFiles(files) {
  for (const file of files) await sendFile(file);
}
async function sendClipboardMedia(file) {
  if (!activeChat) { showToast('Abra uma conversa antes de anexar uma mídia.'); return; }
  if (file.size > 7 * 1024 * 1024) { showToast('O GIF ou a imagem deve ter até 7 MB.'); return; }
  if (!/^image\/(gif|png|jpeg|webp)$/.test(file.type) && file.type !== 'video/mp4') { showToast('Formato não suportado. Escolha um GIF, imagem ou vídeo MP4.'); return; }
  const chatId = activeChat.id;
  const quoted = replyTarget;
  try {
    showToast(file.type === 'image/gif' ? 'Enviando GIF…' : 'Enviando mídia…');
    const dataUrl = await readFileAsDataUrl(file);
    const [, data] = dataUrl.split(',');
    const payload = { data, mimetype: file.type, filename: file.name || (file.type === 'image/gif' ? 'animacao.gif' : 'imagem') };
    if (quoted?.id) payload.quotedMessageId = quoted.id;
    const sent = await api(`/api/chats/${encodeURIComponent(chatId)}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (quoted) sent.replyPreview = { id: quoted.id, body: messagePreview(quoted), fromMe: quoted.fromMe };
    if (activeChat?.id === chatId) appendMessage(sent);
    if (replyTarget === quoted) clearReplyTarget();
  } catch (error) { showToast(error.message); }
}
els.mediaInput.addEventListener('change', async () => {
  const files = [...(els.mediaInput.files || [])];
  els.mediaInput.value = '';
  await sendFiles(files);
});
els.composer.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')) return;
  event.preventDefault();
  els.composer.classList.add('dragging');
});
els.composer.addEventListener('dragleave', (event) => { if (!els.composer.contains(event.relatedTarget)) els.composer.classList.remove('dragging'); });
els.composer.addEventListener('drop', async (event) => {
  els.composer.classList.remove('dragging');
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  await sendFiles(files);
});
els.stickerInput.addEventListener('change', async () => {
  const file = els.stickerInput.files?.[0];
  if (!file || !activeChat) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { showToast('Escolha uma imagem PNG, JPEG ou WebP.'); els.stickerInput.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { showToast('A imagem da figurinha deve ter até 5 MB.'); els.stickerInput.value = ''; return; }
  try {
    showToast('Preparando figurinha…');
    const dataUrl = await readFileAsDataUrl(file);
    const [, data] = dataUrl.split(',');
    const payload = { data, mimetype: file.type, filename: file.name };
    if (replyTarget?.id) payload.quotedMessageId = replyTarget.id;
    const sent = await api(`/api/chats/${encodeURIComponent(activeChat.id)}/stickers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (replyTarget) sent.replyPreview = { id: replyTarget.id, body: messagePreview(replyTarget), fromMe: replyTarget.fromMe };
    appendMessage(sent);
    clearReplyTarget();
  } catch (error) { showToast(error.message); }
  finally { els.stickerInput.value = ''; }
});
els.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); els.composer.requestSubmit(); } });
els.input.addEventListener('paste', async (event) => {
  const clipboardItems = [...(event.clipboardData?.items || [])];
  const mediaItem = clipboardItems.find((item) => item.kind === 'file' && /^image\/(gif|png|jpeg|webp)$/.test(item.type));
  const file = mediaItem?.getAsFile() || [...(event.clipboardData?.files || [])].find((item) => /^image\/(gif|png|jpeg|webp)$/.test(item.type));
  const otherFiles = file ? [] : [...(event.clipboardData?.files || [])];
  if (!file && otherFiles.length) { event.preventDefault(); await sendFiles(otherFiles); return; }
  if (!file) return; // Texto, incluindo emojis, continua sendo inserido normalmente.
  event.preventDefault();
  await sendClipboardMedia(file);
});
els.input.addEventListener('input', () => { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`; });
els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = els.input.value.trim();
  if (!body || !activeChat) return;
  els.input.value = ''; els.input.style.height = 'auto';
  const quoted = replyTarget;
  try {
    const payload = { body };
    if (quoted?.id) payload.quotedMessageId = quoted.id;
    const message = await api(`/api/chats/${encodeURIComponent(activeChat.id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (quoted) message.replyPreview = { id: quoted.id, body: messagePreview(quoted), fromMe: quoted.fromMe };
    appendMessage(message);
    clearReplyTarget();
  }
  catch (error) { els.input.value = body; showToast(error.message); }
});

api('/api/status').then(displayStatus).catch(() => {});
updateNotificationSettings();
