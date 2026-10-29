# Publicar o WPPAPI Chat em um servidor gratuito

O chat roda um Chromium completo (WhatsApp Web), precisa de **pelo menos 1 GB de RAM**, de um processo sempre ligado e de **disco persistente** para guardar a sessão (`.wwebjs_auth`). Sem disco persistente, você terá de ler o QR code de novo a cada reinício.

| Opção | Custo | Adequado? |
|---|---|---|
| **Oracle Cloud – Always Free (Ampere A1)** | Grátis (pede cartão só para verificação) | ✅ Recomendado: até 4 CPUs / 24 GB RAM, disco persistente, não hiberna |
| Google Cloud – e2-micro (Free Tier) | Grátis em `us-west1`, `us-central1` e `us-east1` | ⚠️ Funciona, mas tem só 1 GB de RAM (crie swap) |
| Render / Koyeb (planos free) | Grátis | ❌ 512 MB de RAM, hibernam e não têm disco persistente no plano free |

> ⚠️ **Antes de publicar:** a interface dá acesso total ao WhatsApp conectado (ler e enviar mensagens). Por isso o servidor **não inicia sem `APP_PASSWORD`** dentro do Docker. Use uma senha forte e prefira HTTPS (passo 5), porque em HTTP simples a senha trafega sem criptografia.
>
> Proteções incluídas: tela de login com sessão em cookie `HttpOnly`, bloqueio de 15 minutos após 5 senhas erradas por IP (e de todos os logins após 50 falhas em 15 minutos, caso o IP não seja confiável), recusa de pedidos e conexões em tempo real vindos de outros sites, e arquivos recebidos potencialmente perigosos (HTML, SVG etc.) são sempre baixados, nunca abertos no navegador.
>
> O `whatsapp-web.js` não é oficial. O WhatsApp pode restringir números que usam automação, sobretudo a partir de IPs de datacenter. Prefira um número de testes.

## 1. Criar a VM na Oracle Cloud

1. Crie a conta em <https://www.oracle.com/cloud/free/>.
2. **Compute → Instances → Create instance**:
   - Image: **Ubuntu 24.04** (ou 22.04).
   - Shape: **Ampere → VM.Standard.A1.Flex**, com 2 OCPUs e 12 GB de RAM (dentro do limite gratuito).
   - Baixe a chave SSH gerada.
   - Se aparecer *Out of host capacity*, tente outro *Availability Domain* ou tente mais tarde.
3. Em **Networking → Virtual Cloud Network → Security List**, adicione regras de entrada (*Ingress*) TCP para as portas **80** e **443** (HTTPS) ou **3000** (sem HTTPS), com origem `0.0.0.0/0`.

## 2. Preparar o servidor

```bash
ssh -i sua-chave.key ubuntu@IP_DO_SERVIDOR

# As imagens Ubuntu da Oracle bloqueiam portas no iptables; libere-as:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

Na e2-micro do Google (1 GB de RAM), crie também 2 GB de swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Baixar o projeto

```bash
git clone https://github.com/thiagoreiscontato1-a11y/wppAPI.git
cd wppAPI
```

Se o repositório for privado, use um *Personal Access Token* do GitHub como senha no `git clone`.

## 4. Configurar e subir

```bash
cp .env.example .env
nano .env          # defina APP_PASSWORD (e DOMAIN, se for usar HTTPS)
docker compose up -d --build
docker compose logs -f chat
```

Acesse `http://IP_DO_SERVIDOR:3000`, entre na tela de login com `APP_USER` / `APP_PASSWORD` e leia o QR code em **WhatsApp → Aparelhos conectados → Conectar aparelho**. A sessão fica no volume `wwebjs-data` e sobrevive a reinícios e atualizações.

## 5. HTTPS gratuito (recomendado)

Sem domínio próprio, use o [sslip.io](https://sslip.io): o IP `129.146.10.20` vira `129-146-10-20.sslip.io`. No `.env`:

```env
DOMAIN=129-146-10-20.sslip.io
CHAT_PORT=127.0.0.1:3000
```

Depois, rode:

```bash
docker compose --profile https up -d --build
```

O Caddy emite o certificado Let's Encrypt automaticamente. Acesse `https://129-146-10-20.sslip.io`. Com `CHAT_PORT=127.0.0.1:3000`, a porta 3000 deixa de ficar exposta.

## Manutenção

```bash
git pull && docker compose --profile https up -d --build   # atualizar (use o mesmo comando, sem --profile https, se não usa HTTPS)
docker compose logs -f chat                                # ver logs
docker compose down                                        # parar (mantém a sessão)
docker volume rm wppapi_wwebjs-data                        # apagar a sessão do WhatsApp
```

Quando o WhatsApp Web muda, a `whatsapp-web.js` costuma lançar correções em poucos dias. O repositório avisa por uma issue no GitHub quando há atualização; veja como aplicá-la em [README.md](README.md#atualizar-a-whatsapp-webjs) e depois rode o `git pull` acima no servidor.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `APP_PASSWORD` | — | Senha da interface (obrigatória com `NODE_ENV=production`, que já vem definido na imagem Docker) |
| `APP_USER` | `admin` | Usuário da interface |
| `PORT` | `3000` | Porta HTTP do servidor |
| `MAX_UPLOAD_MB` | `32` | Tamanho máximo de cada arquivo enviado pela interface |
| `WWEBJS_AUTH_PATH` | `chat-app/.wwebjs_auth` (`/data/.wwebjs_auth` no Docker) | Onde a sessão do WhatsApp é salva |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium do Puppeteer (`/usr/bin/chromium` no Docker) | Navegador usado |
| `DOMAIN` | — | Domínio para o HTTPS do Caddy |
| `ALLOWED_ORIGINS` | — | Endereços extras aceitos como o próprio chat (ex.: `https://chat.exemplo.com`), para proxies que reescrevem o cabeçalho `Host`. O endereço do GitHub Codespaces é aceito automaticamente. Se a página ficar em "Reconectando ao servidor…", o log mostra qual origem foi recusada |
| `TRUST_PROXY` | `loopback, uniquelocal` | De quais proxies aceitar `X-Forwarded-For`/`X-Forwarded-Proto` (o padrão cobre o Caddy no Docker). Veja os valores aceitos em <https://expressjs.com/en/guide/behind-proxies.html> |

O endpoint `/healthz` responde sem senha, para *health checks*.
