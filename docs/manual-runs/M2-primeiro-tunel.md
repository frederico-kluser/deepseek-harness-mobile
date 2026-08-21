# M2 — Primeiro túnel (8 min)

**Objetivo:** ligar o túnel pelo bot, validar que a URL vem do `/quicktunnel` (e não de scraping),
abrir pelo celular e codificar de verdade. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1707-1722.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | DSH a correr em `127.0.0.1:3080`; estado inicial | `STOPPED`. **Nada** exposto por padrão | ☐ | — |
| 2 | `/ligar` pelo bot | Pede confirmação (2 etapas, nonce do host); confirmada, resposta em ≤2 s e estado `STARTING` | ☐ | tempo até confirmar |
| 3 | Aguardar a URL | URL chega em ~6–7 s. Se passar de 30 s é falha | ☐ | tempo real medido |
| 4 | Verificar que a URL veio do `/quicktunnel` e não de scraping | O log do plugin regista a fonte | ☐ | linha do log |
| 4b | Antes de a URL existir, conferir o log do **probe de 4 sondas** | As quatro registaram 401. Se alguma der 200 e o túnel subir assim mesmo: **PARE — é o bug que já expôs o DSH real** | ☐ | — |
| 5 | Abrir a URL no **celular, na 4G**, em janela anônima | Prompt/tela de senha. **Se abrir a UI direto: PARE — é o pior bug possível** | ☐ | — |
| 6 | Senha errada 3× | 401 idêntico nas três; a partir da 5ª, atraso perceptível | ☐ | tempos |
| 7 | Senha certa | A Web UI do DSH carrega | ☐ | — |
| 8 | Codificar de facto | Abrir um ficheiro e pedir uma edição ao agente | ☐ | funciona ponto a ponto |
| 9 | `ps aux \| grep cloudflared` | Exatamente 1 processo; `--metrics` em `127.0.0.1`; sem `--loglevel debug`; sem token em argv | ☐ | comando que viste |
| 10 | `curl 127.0.0.1:<porta_metrics>/quicktunnel` e `/ready` | Respondem e confirmam o que o plugin reportou | ☐ | — |
| 11 | Deixar passar o `ttlMinutes` configurado (usa um valor baixo p/ o teste) | O túnel cai sozinho; a sessão aberta no celular deixa de autenticar; o bot avisa | ☐ | — |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
