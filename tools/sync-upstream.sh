#!/usr/bin/env bash
# Traz para este repositório as mudanças da whatsapp-web.js original (wwebjs/whatsapp-web.js).
#
#   bash tools/sync-upstream.sh            aplica as mudanças novas da biblioteca
#   bash tools/sync-upstream.sh --check    só verifica (código de saída 10 = há atualização)
#
# O commit do original já incorporado fica em .upstream-version. As mudanças são aplicadas
# com merge de 3 vias: alterações locais na biblioteca são preservadas e conflitos ficam
# marcados nos arquivos para resolver à mão.
set -euo pipefail

cd "$(dirname "$0")/.."
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/wwebjs/whatsapp-web.js.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LIBRARY_PATHS=(src index.js index.d.ts package.json)
MODE="${1:-}"

CURRENT="$(tr -d '[:space:]' < .upstream-version)"
git fetch --quiet --no-tags "$UPSTREAM_URL" "+$UPSTREAM_BRANCH:refs/remotes/upstream/$UPSTREAM_BRANCH"
LATEST="$(git rev-parse "refs/remotes/upstream/$UPSTREAM_BRANCH")"

if ! git cat-file -e "$CURRENT^{commit}" 2>/dev/null; then
  echo "O commit registrado em .upstream-version ($CURRENT) não existe no original." >&2
  exit 1
fi

CHANGES="$(git log --oneline --no-decorate "$CURRENT..$LATEST" -- "${LIBRARY_PATHS[@]}")"
if [ -z "$CHANGES" ]; then
  echo "A biblioteca já está atualizada (original em ${LATEST:0:7})."
  [ "$CURRENT" != "$LATEST" ] && [ "$MODE" != "--check" ] && echo "$LATEST" > .upstream-version
  exit 0
fi

echo "Mudanças da biblioteca no original desde ${CURRENT:0:7}:"
echo "$CHANGES"
if [ "$MODE" = "--check" ]; then exit 10; fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Há alterações não commitadas. Faça commit ou stash antes de sincronizar." >&2
  exit 1
fi

echo
if git diff --binary "$CURRENT" "$LATEST" -- "${LIBRARY_PATHS[@]}" | git apply --3way --whitespace=nowarn; then
  echo "$LATEST" > .upstream-version
  git add .upstream-version
  echo "Pronto. Revise com 'git diff --cached', rode 'npm install' e os testes, e faça o commit."
else
  echo "$LATEST" > .upstream-version
  git add .upstream-version
  echo "Aplicado com conflitos: resolva os arquivos marcados (git status), rode os testes e faça o commit." >&2
  exit 1
fi
