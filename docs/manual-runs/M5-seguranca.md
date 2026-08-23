# M5 — Segurança na prática (7 min)

**Objetivo:** confirmar pela rede a invariante de "só a credencial abre" e que a **senha permanente**
nunca passa por canal remoto (SEC-14) — o que o produto deixa viajar pelo Telegram é o **link
com `mk` de uso único**, não o segredo permanente. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1748-1761.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | `curl -H 'X-Forwarded-For: 127.0.0.1' <URL>/api/…` de fora | 401/403. XFF ignorado | ☐ | código |
| 2 | `curl <URL>/api/../public/x` e `<URL>/api%2fx` | Bloqueados | ☐ | códigos |
| 3 | `wscat`/`websocat` no endpoint de WS **sem** credencial | 401 cru, socket fechado | ☐ | — |
| 4 | Abrir a URL num navegador limpo e olhar o DevTools | Nenhum segredo em `localStorage`, cookie sem `HttpOnly`, ou corpo de resposta | ☐ | — |
| 5 | `grep -R "$SENHA" ~/.dsh/logs/ /var/log/` | Zero ocorrências | ☐ | — |
| 6 | Verificar o histórico do Telegram | A **senha permanente não está lá, em nenhuma forma**. Entrega é local (terminal/QR) ou por `GET /__guard/secret?ott=` | ☐ | — |
| 6b | Clicar o link mágico duas vezes | Só a primeira emite sessão; a segunda falha e gera alerta | ☐ | — |
| 6c | Errar a senha 15× pelo túnel | As 15 respostas são `401` **idênticos**, sem `Retry-After`; só o tempo muda | ☐ | — |
| 7 | Buscar a URL do túnel no urlscan.io/Google | Regista o resultado. A URL **não é segredo** — é premissa do modelo | ☐ | resultado |
| 8 | Deixar o túnel aberto 30 min e rever o log de acesso | Toda requisição registada; primeiro acesso não reconhecido gera alerta | ☐ | — |

> **PARE se a SENHA PERMANENTE aparecer no chat do Telegram** — é violação do invariante SEC-14.
> O que **pode** aparecer é o **link com `mk` de uso único** — comportamento novo do produto
> (envio automático no `/ligar`). Verificar: o link tem o padrão `#mk=` no fragmento, **não** embute
> o valor da senha, e um mesmo `mk` só serve uma sessão (a segunda tentativa falha e gera alerta).

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
