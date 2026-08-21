# M1 — Onboarding do Telegram do zero (10 min)

**Objetivo:** uma pessoa que nunca viu o projeto cria um bot, cola o token, pareia o chat e
confere a senha — sem ajuda. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1688-1705.

**Pré-requisito (M0):** DSH instalado, `cloudflared` verificado, celular com dados móveis.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | Sem estado prévio, correr `dsh-guard-setup` | Mostra o passo 1 (BotFather) com o texto exato a digitar, sem jargão | ☐ | o texto tem de ser copiável tal e qual |
| 2 | Criar o bot no BotFather (`/newbot`, nome, username a terminar em `bot`) | Recebe token `<id>:<segredo>` | ☐ | guarda o token fora de argv |
| 3 | Colar o token quando pedido | `<id>:<segredo>` · getMe valida e mostra o @username | ☐ | username mostrado é o teu? |
| 4 | Colar um token **errado** de propósito | Erro claro, sem stack trace, com instrução de /token | ☐ | que erro apareceu? |
| 5 | A ferramenta mostra o **código de pareamento de 6 dígitos** | Código só no terminal, TTL de 5 min visível, instrução `/parear <código>` | ☐ | confere que não aparece no bot |
| 6 | Mandar `/start` ao bot **antes** de parear | Responde boas-vindas inócua e **não pareia** ninguém. **Se parear: PARE — é bug de segurança (D8)** | ☐ | — |
| 7 | Mandar `/parear <código errado>` | Recusa genérica; a tentativa é contada; nada é gravado | ☐ | — |
| 8 | Mandar `/parear <código correto>` | Pareia; a ferramenta confirma @username e chat e **fecha** o pareamento | ☐ | — |
| 9 | Mandar `/parear` de novo, ou de outra conta | **Recusado**. Reabrir exige `--reset-pairing` na máquina | ☐ | — |
| 10 | Conferir `~/.dsh/guarded-bot/secrets.env` | Modo `0600`, fora do workspace e fora do git; contém `TELEGRAM_BOT_TOKEN` | ☐ | `stat` o ficheiro |
| 11 | Conferir a senha do painel | Impressa **uma vez**, texto + QR ASCII; a 2ª execução não re-imprime; a senha **não** está em nenhuma mensagem do Telegram | ☐ | — |
| 12 | Correr `dsh-guard-setup` de novo | Diz "já configurado", não duplica linha, não regera segredo, não reabre pareamento | ☐ | — |
| 13 | Ler os 5 avisos de exposição | trustedRemotes inerte sob túnel; túnel fura a firewall; TLS termina na borda; URL não é segredo; trycloudflare tem reputação de malware | ☐ | — |
| 14 | Pedir a uma pessoa que nunca viu o projeto para fazer 1→11 | Conclui sem perguntar nada ao autor. **Este é o critério real** | ☐ | quem, quanto tempo |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
