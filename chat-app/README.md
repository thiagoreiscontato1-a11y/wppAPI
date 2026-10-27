# WPPAPI Chat — prévia de teste

Interface web inspirada no Microsoft Teams para testar conversas do WhatsApp usando a biblioteca `whatsapp-web.js` deste repositório. A aplicação permite conectar por QR code, pesquisar/listar conversas, carregar mensagens recentes e enviar/receber mensagens de texto.

## Rodar no GitHub Codespaces

Na raiz do repositório:

```bash
cd chat-app
npm run setup
npm start
```

Abra a porta **3000** na aba *Ports* do Codespaces. No primeiro acesso, leia o QR code exibido na página pelo WhatsApp em **Aparelhos conectados → Conectar aparelho**. A sessão fica em `chat-app/.wwebjs_auth` e é ignorada pelo Git.

O comando `npm run setup` instala as dependências de produção da biblioteca local, instala as dependências da interface e baixa o Chrome usado pelo Puppeteer. Na configuração do Codespaces, as bibliotecas do sistema necessárias ao Chrome são instaladas no primeiro provisionamento do contêiner.

## Observações

- Esta é uma prévia para testes; não possui login próprio, persistência de mensagens, envio de mídia nem controles de produção.
- As mensagens são enviadas pela conta WhatsApp que escanear o QR code.
- Mantenha o Codespace privado e nunca publique a pasta `.wwebjs_auth`: ela contém credenciais da sessão.
- Para encerrar, pare o processo no terminal. Use o botão de saída para desconectar o WhatsApp.

## Mídia e fotos de perfil

A prévia carrega fotos de perfil sob demanda e exibe imagens, vídeos e áudios dentro da conversa. Documentos aparecem como links para abrir ou baixar. Algumas fotos podem não aparecer se as configurações de privacidade do contato impedirem o acesso; nesse caso, a interface mantém as iniciais.
