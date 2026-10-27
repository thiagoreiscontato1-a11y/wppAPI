const socket = io();
const $ = (id) => document.getElementById(id);
const els = {
  overlay: $('connectOverlay'), title: $('connectTitle'), text: $('connectText'), qrWrap: $('qrWrap'), qr: $('qrImage'),
  spinner: $('connectSpinner'), error: $('connectError'), retry: $('retryBtn'), chatList: $('chatList'), search: $('searchInput'),
  empty: $('emptyState'), thread: $('thread'), conversation: document.querySelector('.conversation'), messages: $('messages'),
  name: $('threadName'), meta: $('threadMeta'), avatar: $('threadAvatar'), input: $('messageInput'), composer: $('composer'),
};
let statusState = 'starting';
let chats = [];
let activeChat = null;
let renderedIds = new Set();
const profilePictureCache = new Map();
const profilePicturePending = new Set();
const profilePictureQueue = [];
let profilePictureActive = 0;
let profileObserver;
let toastTimer;

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
function displayStatus(data) {
  statusState = data.state;
  const connected = data.state === 'ready';
  $('sidebarStatus').textContent = connected ? 'WhatsApp conectado' : data.state === 'qr' ? 'Aguardando leitura do QR' : 'Conectando ao WhatsApp';
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
  else if (data.state === 'authenticated') { els.title.textContent = 'Celular conectado'; els.text.textContent = 'Sincronizando conversas…'; }
  else if (data.state === 'error' || data.state === 'disconnected') { els.title.textContent = 'Não foi possível conectar'; els.text.textContent = 'Confira a sessão do WhatsApp e tente iniciar novamente.'; }
  else { els.title.textContent = 'Conectando ao WhatsApp'; els.text.textContent = 'Iniciando uma sessão segura no Codespace…'; }
}
socket.on('status', displayStatus);
socket.on('message', ({ chatId, message }) => {
  if (activeChat?.id === chatId) appendMessage(message);
  const chat = chats.find((item) => item.id === chatId);
  if (chat) { chat.lastMessage = message.body || (message.hasMedia ? '📎 Mídia' : ''); chat.timestamp = message.timestamp; renderChats(); }
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
  if (mediaUrl && ['image', 'sticker'].includes(message.type)) attachment = `<a class="media-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="inline-image" src="${mediaUrl}" alt="Imagem recebida" loading="lazy" /></a>`;
  else if (mediaUrl && message.type === 'video') attachment = `<video class="inline-video" src="${mediaUrl}" controls preload="none"></video>`;
  else if (mediaUrl && ['audio', 'ptt'].includes(message.type)) attachment = `<audio class="inline-audio" src="${mediaUrl}" controls preload="none"></audio>`;
  else if (mediaUrl && message.type === 'document') attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener" download>📎 Abrir ou baixar documento</a>`;
  else if (message.hasMedia) attachment = `<a class="document-link" href="${mediaUrl}" target="_blank" rel="noopener">📎 Abrir mídia (${escapeHtml(message.type || 'arquivo')})</a>`;
  const content = `${attachment}${message.body ? `${attachment ? '<br>' : ''}${escapeHtml(message.body)}` : (!attachment ? `<span class="message-media">${escapeHtml(message.type || 'Mensagem')}</span>` : '')}`;
  const row = document.createElement('div');
  row.className = `message-row ${message.fromMe ? 'mine' : ''}`;
  row.innerHTML = `<div class="mini-avatar">${escapeHtml(message.fromMe ? 'T' : initials(activeChat?.name))}</div><div class="message-content">${message.fromMe ? '' : `<div class="sender-name">${escapeHtml(message.author || activeChat?.name || '')}</div>`}<div class="message-bubble">${content}</div><div class="message-meta">${time}${message.fromMe ? '<span class="message-status">✓✓</span>' : ''}</div></div>`;
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}
async function openChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  activeChat = chat; renderedIds = new Set();
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
$('logoutBtn').addEventListener('click', async () => { if (!confirm('Desconectar esta sessão do WhatsApp?')) return; try { await api('/api/logout', { method: 'POST' }); } catch (error) { showToast(error.message); } });
$('retryBtn').addEventListener('click', () => location.reload());
els.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); els.composer.requestSubmit(); } });
els.input.addEventListener('input', () => { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 100)}px`; });
els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = els.input.value.trim();
  if (!body || !activeChat) return;
  els.input.value = ''; els.input.style.height = 'auto';
  try { const message = await api(`/api/chats/${encodeURIComponent(activeChat.id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }); appendMessage(message); }
  catch (error) { els.input.value = body; showToast(error.message); }
});

api('/api/status').then(displayStatus).catch(() => {});
