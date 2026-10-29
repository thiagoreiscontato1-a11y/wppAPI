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

O comando `npm run setup` instala as dependências de produção da biblioteca local, instala o FFmpeg (usado para converter GIFs em vídeo animado), instala as dependências da interface e baixa o Chrome usado pelo Puppeteer. Na configuração do Codespaces, as bibliotecas do sistema necessárias ao Chrome são instaladas no primeiro provisionamento do contêiner.

## Publicar em um servidor

Para hospedar o chat em um servidor gratuito (Oracle Cloud Always Free, com Docker e HTTPS), siga o guia [DEPLOY.md](DEPLOY.md). Fora do Codespaces, defina sempre `APP_PASSWORD`: ela protege a interface com usuário e senha.

## Observações

- Esta é uma prévia para testes; o acesso é protegido apenas por usuário e senha básicos (`APP_USER`/`APP_PASSWORD`), sem persistência de mensagens, envio de mídia nem controles de produção.
- As mensagens são enviadas pela conta WhatsApp que escanear o QR code.
- Mantenha o Codespace privado e nunca publique a pasta `.wwebjs_auth`: ela contém credenciais da sessão.
- Para encerrar, pare o processo no terminal. Use o botão de saída para desconectar o WhatsApp.

## Mídia e fotos de perfil

A prévia carrega fotos de perfil sob demanda e exibe imagens, vídeos e áudios dentro da conversa. Documentos aparecem como links para abrir ou baixar. Algumas fotos podem não aparecer se as configurações de privacidade do contato impedirem o acesso; nesse caso, a interface mantém as iniciais.

O botão de figurinha permite selecionar PNG, JPEG ou WebP (até 5 MB) e envia a imagem como figurinha. Use o botão **↩** em uma mensagem para selecioná-la como citação; a resposta pode ser uma mensagem de texto ou uma figurinha.

O seletor no cabeçalho alterna entre tema claro e escuro e guarda a escolha neste navegador. Mensagens novas em outras conversas mostram um aviso discreto e atualizam o contador de não lidas; o aviso fecha sozinho e não solicita permissão do navegador.

O controle de som ao lado do tema liga ou silencia o toque curto das notificações. O navegador libera áudio após a primeira interação do usuário com a página; o som é limitado a um toque a cada 2,2 segundos.
