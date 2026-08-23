# M5 — Segurança na prática (7 min)

**Objetivo:** confirmar o modelo novo de acesso — o local abre direto (sem login) e o
túnel só entra por **sessão ou chave no link `?key=`**; a chave pode aparecer no chat
(é o mecanismo de entrega) e é **revogável por rotação**. Não existe senha a digitar
em lugar nenhum. Fonte: [`docs/THREAT-MODEL.md`](../THREAT-MODEL.md) §5 e o teste
`test/security/desafio-401.test.ts`.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | `curl -H 'X-Forwarded-For: 127.0.0.1' <URL>/?key=invalida` de fora | 401. XFF ignorado | ☐ | código |
| 2 | `curl <URL>/api/../public/x` e `<URL>/api%2fx` | Bloqueados | ☐ | códigos |
| 3 | `wscat`/`websocat` no endpoint de WS **sem** sessão | 401 cru sem desafio de login, socket fechado | ☐ | — |
| 4 | Abrir a URL raiz do túnel num navegador limpo, **sem** `?key=` | `401` sem popup de login (sem desafio) | ☐ | — |
| 5 | Abrir o link com `?key=<token>` que o bot enviou | Acesso concedido (302 p/ URL limpa + sessão); a URL passa a **não** conter `?key=` | ☐ | — |
| 5b | Abrir o túnel por `127.0.0.1` (local) | Abre direto, `200`, **sem** desafio | ☐ | — |
| 6 | Verificar o histórico do Telegram | A **chave do link** está lá (é o mecanismo de entrega). **Nenhuma outra credencial** aparece | ☐ | — |
| 6c | Errar a chave 15× pelo túnel | As 15 respostas são `401` **idênticos**, sem `Retry-After`; só o tempo muda | ☐ | — |
| 7 | Buscar a URL do túnel no urlscan.io/Google | Regista o resultado. A URL **não é segredo** — é premissa do modelo | ☐ | resultado |
| 8 | Deixar o túnel aberto 30 min e rever o log de acesso | Toda requisição registada; primeiro acesso não reconhecido gera alerta | ☐ | — |

> **A CHAVE do link PODE aparecer no chat do Telegram — é esperado e é o mecanismo.**
> O que se verifica é o **contrato de revogação**: (a) abrir a URL raiz do túnel **sem**
> a chave dá `401` sem desafio; (b) abrir com a chave acede; (c) depois de `/rotacionar`,
> o **mesmo link antigo deixa de funcionar** (`401`) e o bot entrega a chave nova;
> (d) derrubar o túnel (`/desligar`, `/emergencia`) também revoga. **Não existe senha
> permanente para acesso** — não há valor cuja presença no chat seja violação; qualquer
> credencial que **não** seja a chave do link (ex.: token do bot, segredo interno) não
> deve aparecer.

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar: