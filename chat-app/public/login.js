const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const submit = document.getElementById('loginSubmit');

// Já autenticado (ou sem senha configurada): vai direto para o chat.
fetch('/api/status').then((response) => { if (response.ok) location.replace('/'); }).catch(() => {});

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!user || !password) { showError('Preencha o usuário e a senha.'); return; }
  submit.disabled = true;
  submit.textContent = 'Entrando…';
  errorBox.classList.add('hidden');
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
    location.replace('/');
  } catch (error) {
    showError(error.message);
    document.getElementById('loginPassword').select();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Entrar';
  }
});
