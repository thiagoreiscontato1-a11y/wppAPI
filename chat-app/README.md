# WPPAPI Chat — prévia de teste

Interface web inspirada no Microsoft Teams para testar conversas do WhatsApp usando a biblioteca `whatsapp-web.js` deste repositório. A aplicação permite conectar por QR code, pesquisar/listar conversas, carregar mensagens recentes e enviar/receber mensagens de texto.

## Rodar no GitHub Codespaces

Na raiz do repositório:

```bash
cd chat-app
npm install
npm start
```

Abra a porta **3000** na aba *Ports* do Codespaces. No primeiro acesso, leia o QR code exibido na página pelo WhatsApp em **Aparelhos conectados → Conectar aparelho**. A sessão fica em `chat-app/.wwebjs_auth` e é ignorada pelo Git.

O Codespace precisa permitir que o Chromium/Puppeteer inicie. O primeiro `npm install` também instala o Chromium baixado pelo Puppeteer, o que pode levar alguns minutos.

## Observações

- Esta é uma prévia para testes; não possui login próprio, persistência de mensagens, envio de mídia nem controles de produção.
- As mensagens são enviadas pela conta WhatsApp que escanear o QR code.
- Mantenha o Codespace privado e nunca publique a pasta `.wwebjs_auth`: ela contém credenciais da sessão.
- Para encerrar, pare o processo no terminal. Use o botão de saída para desconectar o WhatsApp.
