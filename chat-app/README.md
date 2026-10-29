# WPPAPI Chat — prévia de teste

Interface web para testar conversas do WhatsApp usando a biblioteca `whatsapp-web.js` deste repositório. Mistura o melhor de Slack, WhatsApp e Teams: barra lateral escura com as conversas e filtros (Todas, Não lidas, Grupos), balões com confirmação de leitura e caixa de mensagem com as ferramentas embaixo. A aplicação permite conectar por QR code, pesquisar/listar conversas, carregar mensagens recentes e enviar/receber mensagens de texto. No celular, a lista e a conversa ocupam a tela uma de cada vez, e o botão voltar retorna à lista.

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

Para hospedar o chat em um servidor gratuito (Oracle Cloud Always Free, com Docker e HTTPS), siga o guia [DEPLOY.md](DEPLOY.md). Fora do Codespaces, defina sempre `APP_PASSWORD`: com ela a interface exige login (usuário `APP_USER`, padrão `admin`).

## Observações

- Esta é uma prévia para testes, sem persistência de mensagens nem controles de produção. Com `APP_PASSWORD` definida, a interface abre uma tela de login; a sessão dura 7 dias (ou até clicar em **Sair desta interface**) e é encerrada se o servidor reiniciar. Após 5 senhas erradas, o IP fica bloqueado por 15 minutos.
- No menu de configurações (engrenagem ao lado do seu nome, no rodapé da barra lateral), **Desconectar o WhatsApp** desconecta o celular do servidor; **Sair desta interface** apenas encerra o login nesta interface.
- As mensagens são enviadas pela conta WhatsApp que escanear o QR code.
- Mantenha o Codespace privado e nunca publique a pasta `.wwebjs_auth`: ela contém credenciais da sessão.
- Para encerrar, pare o processo no terminal. Use **Desconectar o WhatsApp** no menu de configurações para desconectar o celular.

## Mídia e fotos de perfil

A prévia carrega fotos de perfil sob demanda e exibe imagens, vídeos e áudios dentro da conversa, com suporte a avançar e voltar a reprodução. Documentos aparecem como links com o nome do arquivo para abrir ou baixar.

Ao abrir uma conversa são carregadas as 80 mensagens mais recentes; role até o topo (ou use **Carregar mensagens anteriores**) para buscar mais 50 por vez até o início da conversa.

O botão de clipe envia um ou vários arquivos de uma vez (também é possível arrastar ou colar arquivos na caixa de mensagem). Fotos JPEG/PNG/WebP, vídeos MP4 e áudios MP3/OGG/M4A aparecem direto na conversa; GIFs viram animações; os demais formatos (PDF, planilhas, ZIP etc.) vão como documento. O limite padrão é 32 MB por arquivo, ajustável pela variável `MAX_UPLOAD_MB`. Algumas fotos podem não aparecer se as configurações de privacidade do contato impedirem o acesso; nesse caso, a interface mantém as iniciais.

O botão de figurinha permite selecionar PNG, JPEG ou WebP (até 5 MB) e envia a imagem como figurinha. Passe o mouse sobre uma mensagem (no celular, toque na seta ao lado dela) e use **Responder** para selecioná-la como citação; a resposta pode ser uma mensagem de texto ou uma figurinha.

O menu de configurações alterna entre tema claro e escuro e guarda a escolha neste navegador; sem escolha salva, a interface segue o tema do sistema. Mensagens novas em outras conversas mostram um aviso discreto e atualizam o contador de não lidas; o aviso fecha sozinho e não solicita permissão do navegador.

No mesmo menu, **Som de nova mensagem** liga ou silencia o toque curto das notificações. O navegador libera áudio após a primeira interação do usuário com a página; o som é limitado a um toque a cada 2,2 segundos.

## Estrutura do código e testes

| Arquivo | Responsabilidade |
|---|---|
| `server.js` | Ponto de entrada: lê as variáveis de ambiente, carrega a `whatsapp-web.js` e inicia o servidor |
| `app.js` | Monta o servidor (Express + Socket.IO), a autenticação e as rotas da API |
| `lib/whatsapp.js` | Conexão com o WhatsApp: inicia, reconecta quando a sessão cai e repassa os eventos |
| `lib/auth.js` | Login, sessões, limite de tentativas e verificação de origem |
| `lib/messages.js` | Conversão das mensagens para a interface e paginação do histórico |
| `lib/media.js` | Validade das fotos de perfil, pedidos parciais de mídia e tipos de arquivo |
| `lib/cache.js` | Cache em memória com validade e limite de tamanho |
| `public/` | Interface (HTML, CSS e JavaScript sem etapa de build) |

Os testes usam um cliente WhatsApp falso (`test/helpers/fake-whatsapp.js`), então rodam sem celular nem navegador:

```bash
npm --prefix chat-app test
```

Eles também rodam no GitHub Actions a cada push, junto com o ESLint (`npm run lint` na raiz).

## Atualizar a whatsapp-web.js

A biblioteca na raiz do repositório é uma cópia da [whatsapp-web.js original](https://github.com/wwebjs/whatsapp-web.js); o commit incorporado fica em `.upstream-version`. Toda segunda-feira o workflow **Upstream check** abre uma issue se o original tiver mudanças novas. Para trazê-las:

```bash
bash tools/sync-upstream.sh          # aplica as mudanças (use --check para só verificar)
npm install && npm --prefix chat-app test
git commit -m "Atualiza whatsapp-web.js"
```

O script faz merge de 3 vias: ajustes locais na biblioteca são preservados, e eventuais conflitos ficam marcados nos arquivos.
