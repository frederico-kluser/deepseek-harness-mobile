#!/usr/bin/env bash
# S12 — corre o laboratorio de interceptacao completo.
#
#   bash scripts/spike/intercept/run.sh
#
# Instala as dependencias do laboratorio em `scripts/spike/intercept/node_modules`
# (ignorado pelo .gitignore da raiz). NAO toca no package.json do projecto.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
echo "### node $(node --version) | webserver $(node -p "require('./node_modules/@deepseek-ai/dsh-host-webserver/package.json').version") | cordis $(node -p "require('./node_modules/@deepseek-ai/cordis/package.json').version")"
echo
node experimento.mjs
echo
node falsificacao.mjs
echo
node posse.mjs
echo
node arte-previa.mjs
