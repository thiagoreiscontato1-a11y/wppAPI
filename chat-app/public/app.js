const socket = io();
const $ = (id) => document.getElementById(id);
const els = {
  overlay: $('connectOverlay'), title: $('connectTitle'), text: $('connectText'), qrWrap: $('qrWrap'), qr: $('qrImage'),
  spinner: $('connectSpinner'), error: $('connectError'), retry: $('retryBtn'), chatList: $('chatList'), search: $('searchInput'),
  empty: $('emptyState'), thread: $('thread'), conversation: document.querySelector('.conversation'), messages: $('messages'),
  name: $('threadName'), meta: $('threadMeta'), avatar: $('threadAvatar'), input: $('messageInput'), composer: $('composer'),
  replyBar: $('replyBar'), replyAuthor: $('replyAuthor'), replyText: $('replyText'), stickerInput: $('stickerInput'),
};
let statusState = 'starting';
let chats = [];
let activeChat = null;
let replyTarget = null;
let renderedIds = new Set();
const profilePictureCache = new Map();
const profilePicturePending = new Set();
const profilePictureQueue = [];
let profilePictureActive = 0;
let profileObserver;
let toastTimer;
let noticeTimer;
let notificationAudioContext = null;
let lastNotificationSoundAt = 0;
let notificationSoundEnabled = true;

try { notificationSoundEnabled = localStorage.getItem('wppapi-chat-sound') !== 'off'; } catch {}

function setTheme(theme, persist = true) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const button = $('themeToggle');
  button.textContent = dark ? '☼' : '☾';
  button.title = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#1b1c22' : '#464775';
  if (persist) {
    try { localStorage.setItem('wppapi-chat-theme', dark ? 'dark' : 'light'); } catch {}
  }
}

try { setTheme(localStorage.getItem('wppapi-chat-theme') || 'light', false); }
catch { setTheme('light', false); }

function updateSoundToggle() {
  const button = $('soundToggle');
  button.textContent = notificationSoundEnabled ? '♪' : '♩';
  button.title = notificationSoundEnabled ? 'Desativar som das notificações' : 'Ativar som das notificações';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(notificationSoundEnabled));
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
  const notice = $('messageNotice');
  $('noticeTitle').textContent = chat?.name || 'Nova mensagem';
  $('noticeBody').textContent = messagePreview(message);
  notice.dataset.chatId = chat?.id || '';
  notice.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add('hidden'), 4800);
}

function initials(text = '?') { return text.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'; }
function escapeHtml(text = '') { return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function showToast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
function applyProfilePicture(chatId, url) {
  document.querySelectorAll('.profile-picture-slot').forEach((slot) => {
    if (slot.dataset.profileId !== chatId) return;
    slot.querySelector('img')?.remove();
    slot.classList.remove('has-photo');
    if (!url) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.onload = () => slot.classList.add('has-photo');
    img.onerror = () => img.remove();
    slot.appendChild(img);
  });
}
function queueProfilePicture(chatId) {
  if (profilePictureCache.has(chatId)) { applyProfilePicture(chatId, profilePictureCache.get(chatId)); return; }
  if (profilePicturePending.has(chatId)) return;
  profilePicturePending.add(chatId);
  profilePictureQueue.push(chatId);
  processProfilePictureQueue();
}
function processProfilePictureQueue() {
  while (profilePictureActive < 2 && profilePictureQueue.length) {
    const chatId = profilePictureQueue.shift();
    profilePictureActive += 1;
    api(`/api/chats/${encodeURIComponent(chatId)}/profile-picture`)
      .then(({ url }) => { profilePictureCache.set(chatId, url || null); applyProfilePicture(chatId, url || null); })
      .catch(() => { profilePictureCache.set(chatId, null); })
      .finally(() => { profilePicturePending.delete(chatId); profilePictureActive -= 1; processProfilePictureQueue(); });
  }
}
function messagePreview(message) {
  if (message.body) return message.body;
  if (!message.hasMedia) return 'Mensagem';
  return ({ sticker: 'Figurinha', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', ptt: 'Mensagem de voz', document: 'Documento' })[message.type] || 'Mídia anexada';
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
  const connected = data.state === 'ready';
  $('sidebarStatus').textContent = connected ? 'WhatsApp conectado' : data.state === 'qr' ? 'Aguardando leitura do QR' : data.state === 'authenticated' ? 'Sincronizando WhatsApp' : 'Conectando ao WhatsApp';
  $('sidebarDot').classList.toggle('ready', connected);
  if (connected) { els.overlay.classList.add('hidden'); loadChats(); return; }
  els.overlay.classList.remove('hidden');
  els.qrWrap.classList.toggle('hidden', !data.qrDataUrl);
  els.qr.src = data.qrDataUrl || '';
  els.spinner.classList.toggle('hidden', Boolean(data.qrDataUrl) || data.state === 'error');
  els.retry.classList.toggle('hidden', data.state !== 'error' && data.state !== 'disconnected');
  els.error.classList.toggle('hidden', !data.error);
  els.error.textContent = data.error || '';
  if (data.state === 'qr') { els.title.textContent = 'Conecte seu WhatsApp'; els.text.textContent = 'Leia o QR code abaixo com o celular que ficará conectado a este teste.'; }
  else if (data.state === 'authenticated') {
    els.title.textContent = 'Celular conectado';
    els.text.textContent = Number.isFinite(data.loadingPercent) ? `Sincronizando conversas… ${data.loadingPercent}%` : 'WhatsApp autenticado. Aguardando a sincronização inicial…';
  }
  else if (data.state === 'error' || data.state === 'disconnected') { els.title.textContent = 'Não foi possível conectar'; els.text.textContent = 'Confira a sessão do WhatsApp e tente iniciar novamente.'; }
  else { els.title.textContent = 'Conectando ao WhatsApp'; els.text.textContent = 'Iniciando uma sessão segura no Codespace…'; }
}
socket.on('status', displayStatus);
socket.on('message', ({ chatId, message }) => {
  if (activeChat?.id === chatId) appendMessage(message);
  const chat = chats.find((item) => item.id === chatId);
  if (chat) {
    const isVisibleConversation = activeChat?.id === chatId && !document.hidden;
    if (!message.fromMe && !isVisibleConversation) chat.unreadCount = (chat.unreadCount || 0) + 1;
    chat.lastMessage = messagePreview(message);
    chat.timestamp = message.timestamp;
    renderChats();
    if (!message.fromMe && !isVisibleConversation) {
      showMessageNotification(chat, message);
      playNotificationSound();
    }
  }
});
socket.on('connect_error', () => showToast('Reconectando ao servidor…'));

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
  return data;
}
function timeLabel(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function renderChats() {
  const query = els.search.value.trim().toLocaleLowerCase('pt-BR');
  const shown = chats.filter((chat) => `${chat.name} ${chat.number} ${chat.lastMessage}`.toLocaleLowerCase('pt-BR').includes(query));
  if (!shown.length) { els.chatList.innerHTML = `<div class="list-loading">${chats.length ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa encontrada.'}</div>`; return; }
  els.chatList.innerHTML = shown.map((chat) => `<div class="chat-row ${activeChat?.id === chat.id ? 'selected' : ''}" data-id="${escapeHtml(chat.id)}">
    <div class="chat-avatar profile-picture-slot ${chat.isGroup ? 'group' : ''}" data-profile-id="${escapeHtml(chat.id)}"><span class="avatar-initials">${escapeHtml(initials(chat.name))}</span>${!chat.isGroup ? '<i class="presence"></i>' : ''}</div>
    <div class="chat-copy"><div class="chat-line"><span class="chat-name">${escapeHtml(chat.name)}</span><span class="chat-time">${timeLabel(chat.timestamp)}</span></div><div class="chat-line"><span class="chat-preview">${escapeHtml(chat.lastMessage || (chat.isGroup ? 'Grupo' : chat.number))}</span>${chat.unreadCount ? `<span class="unread">${chat.unreadCount}</span>` : ''}</div></div>
  </div>`).join('');
  els.chatList.querySelectorAll('.chat-row').forEach((row) => row.addEventListener('click', () => openChat(row.dataset.id)));
  profileObserver?.disconnect();
  profileObserver = new IntersectionObserver((items) => {
    items.forEach((item) => {
      if (!item.isIntersecting) return;
      profileObserver.unobserve(item.target);
      queueProfilePicture(item.target.dataset.profileId);
    });
  }, { root: els.chatList, rootMargin: '80px' });
  els.chatList.querySelectorAll('.profile-picture-slot').forEach((slot) => {
    if (profilePictureCache.has(slot.dataset.profileId)) applyProfilePicture(slot.dataset.profileId, profilePictureCache.get(slot.dataset.profileId));
    else profileObserver.observe(slot);
  });
}
async function loadChats() {
  if (statusState !== 'ready') return;
  try { chats = await api('/api/chats'); renderChats(); }
  catch (error) { els.chatList.innerHTML = `<div class="list-loading">${escapeHtml(error.message)}</div>`; }
}
function dayLabel(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Hoje';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function appendMessage(message) {
  if (message.id && renderedIds.has(message.id)) return;
  if (message.id) renderedIds.add(message.id);
  const time = timeLabel(message.timestamp);
  const mediaUrl = message.hasMedia && message.id ? `/api/media/${encodeURIComponent(message.id)}` : '';
  let attachment = '';
  if (mediaUrl && message.type === 'sticker') attachment = `<a class="media-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="inline-sticker" src="${mediaUrl}" alt="Figurinha" loading="lazy" /></a>`;
  else if (mediaUrl && message.type === 'image') attachment = `<a class="media-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="inline-image" src="${mediaUrl}" alt="Imagem recebida" loading="lazy" /></a>`;
  else if (mediaUrl && message.type === 'video') attachment = `<video class="inline-video" src="${mediaUrl}" controls preload="none"></video>`;
  else if (mediaUrl && ['audio', 'ptt'].includes(message.type)) attachment = `<audio class="inline-audio" src="${mediaUrl}" controls preload="none"></audio>`;
  else if (mediaUrl && message.type === 'document') attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener" download>📎 Abrir ou baixar documento</a>`;
  else if (message.hasMedia) attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener">📎 Abrir mídia (${escapeHtml(message.type || 'arquivo')})</a>`;
  const content = `${attachment}${message.body ? `${attachment ? '<br>' : ''}${escapeHtml(message.body)}` : (!attachment ? `<span class="message-media">${escapeHtml(message.type || 'Mensagem')}</span>` : '')}`;
  const quote = message.replyPreview || message.quotedMessage;
  const quoteText = quote ? (quote.body || (quote.hasMedia ? messagePreview(quote) : 'Mensagem')) : '';
  const quoteHtml = quote ? `<div class="quoted-message"><strong>${escapeHtml(quote.fromMe ? 'Você' : (quote.author || 'Mensagem citada'))}</strong><span>${escapeHtml(quoteText)}</span></div>` : '';
  const row = document.createElement('div');
  row.className = `message-row ${message.fromMe ? 'mine' : ''}`;
  row.innerHTML = `<div class="mini-avatar">${escapeHtml(message.fromMe ? 'T' : initials(activeChat?.name))}</div><div class="message-content">${message.fromMe ? '' : `<div class="sender-name">${escapeHtml(message.author || activeChat?.name || '')}</div>`}<div class="message-bubble">${quoteHtml}${content}</div><div class="message-meta"><button class="reply-message-button" type="button" title="Responder a esta mensagem" aria-label="Responder a esta mensagem">↩</button>${time}${message.fromMe ? '<span class="message-status">✓✓</span>' : ''}</div></div>`;
  row.querySelector('.reply-message-button').addEventListener('click', () => setReplyTarget(message));
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}
async function openChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  activeChat = chat; renderedIds = new Set();
  clearReplyTarget();
  els.name.textContent = chat.name;
  els.meta.textContent = chat.isGroup ? `Grupo · ${chat.number}` : chat.number;
  els.avatar.innerHTML = `<span class="avatar-initials">${escapeHtml(initials(chat.name))}</span>`;
  els.avatar.dataset.profileId = chat.id;
  els.avatar.classList.add('profile-picture-slot');
  els.avatar.classList.toggle('group', chat.isGroup);
  queueProfilePicture(chat.id);
  els.empty.classList.add('hidden'); els.thread.classList.remove('hidden'); els.conversation.classList.add('thread-open');
  renderChats();
  els.messages.innerHTML = '<div class="messages-loading">Carregando mensagens…</div>';
  try {
    const messages = await api(`/api/chats/${encodeURIComponent(id)}/messages?limit=80`);
    els.messages.innerHTML = '';
    let priorDay = '';
    messages.forEach((message) => {
      const day = dayLabel(message.timestamp);
      if (day !== priorDay) { const divider = document.createElement('div'); divider.className = 'day-divider'; divider.textContent = day; els.messages.appendChild(divider); priorDay = day; }
      appendMessage(message);
    });
    els.messages.scrollTop = els.messages.scrollHeight;
    chat.unreadCount = 0; renderChats();
  } catch (error) { els.messages.innerHTML = `<div class="messages-loading">${escapeHtml(error.message)}</div>`; }
  els.input.focus();
}
els.search.addEventListener('input', renderChats);
$('refreshBtn').addEventListener('click', loadChats);
$('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('soundToggle').addEventListener('click', () => {
  notificationSoundEnabled = !notificationSoundEnabled;
  updateSoundToggle();
  try { localStorage.setItem('wppapi-chat-sound', notificationSoundEnabled ? 'on' : 'off'); } catch {}
  if (notificationSoundEnabled) unlockNotificationAudio();
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
$('messageNotice').tabIndex = 0;
$('logoutBtn').addEventListener('click', async () => { if (!confirm('Desconectar esta sessão do WhatsApp?')) return; try { await api('/api/logout', { method: 'POST' }); } catch (error) { showToast(error.message); } });
$('retryBtn').addEventListener('click', () => location.reload());
$('cancelReplyBtn').addEventListener('click', clearReplyTarget);
$('stickerBtn').addEventListener('click', () => els.stickerInput.click());
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
els.input.addEventListener('input', () => { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 100)}px`; });
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
