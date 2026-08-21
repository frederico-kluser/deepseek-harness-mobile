#!/usr/bin/env bash
#
# run.sh — critério de aceite do examples/minimal
#
#  1. sem credencial                     -> 401
#  2. com a credencial do dono (dsh:DEMO) -> 200
#  3. ao fechar, NENHUM processo sobrante (pgrep vazio)
#
# Pré-requisito: Node >= 24 e o plugin construído (dist/ na raiz). Corre tudo
# em 127.0.0.1; não toca a rede.
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT=../..

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo '> dist/ não encontrado; a construir o plugin...'
  (cd "$ROOT" && pnpm run build >/dev/null)
fi

DEMO_SECRET='K7QF-2M9X-4TZP-9WQ2-8BND-3XKR-7MPV'
LOG=$(mktemp)

echo '> a subir o servidor guardado...'
node server.mjs >"$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

PORT=''
for i in $(seq 1 80); do
  PORT=$(sed -n 's/.*GUARD_MINIMAL_LISTENING http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$LOG" | head -1)
  [ -n "$PORT" ] && break
  sleep 0.1
done

if [ -z "$PORT" ]; then
  echo "ERRO: o servidor não imprimiu a porta."
  echo "--- log ---"; cat "$LOG"
  exit 1
fi
BASE="http://127.0.0.1:$PORT"
echo "> ouvindo em $BASE"

echo '> 1) sem credencial (espera 401)...'
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state")
echo "   -> $UNAUTH"

echo '> 2) com a credencial do dono (espera 200)...'
AUTH=$(curl -s -o /dev/null -w '%{http_code}' -u "dsh:$DEMO_SECRET" "$BASE/api/state")
echo "   -> $AUTH"

OK=1
[ "$UNAUTH" = "401" ] || { echo "FALHOU: esperava 401, veio $UNAUTH"; OK=0; }
[ "$AUTH" = "200" ] || { echo "FALHOU: esperava 200, veio $AUTH"; OK=0; }
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

echo '> 3) nenhum processo sobrante (pgrep vazio)...'
LEFTOVER=$(pgrep -f 'examples/minimal/server.mjs' || true)
if [ -n "$LEFTOVER" ]; then echo "FALHOU: processos sobrantes: $LEFTOVER"; OK=0; fi

if [ "$OK" = "1" ]; then
  echo 'ACEITE OK: 401 sem credencial / 200 com credencial / nenhum processo ao fim.'
  exit 0
else
  echo 'ACEITE FALHOU.'
  exit 1
fi
