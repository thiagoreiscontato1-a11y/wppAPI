// Aplica o tema salvo antes da página aparecer, para não piscar no tema errado.
// Sem escolha salva, segue o tema do sistema.
(() => {
  let theme = null;
  try { theme = localStorage.getItem('wppapi-chat-theme'); } catch {}
  if (theme !== 'dark' && theme !== 'light') theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
})();
