#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"

echo "Instalando dependências de produção da whatsapp-web.js..."
npm --prefix "$REPO_DIR" install --omit=dev --ignore-scripts

echo "Instalando dependências do chat..."
npm --prefix "$APP_DIR" install

echo "Baixando o Chrome compatível com o Puppeteer..."
"$REPO_DIR/node_modules/.bin/puppeteer" browsers install chrome

echo "Preparação concluída. Inicie com: npm start"
