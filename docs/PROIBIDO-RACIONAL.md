# PROIBIDO.md — afirmações NÃO CONFIRMADAS (lista fechada; COMMIT PREP 7)
Nenhuma das afirmações abaixo pode aparecer em README, CHANGELOG, post, GIF ou material
público — nem como facto, nem como justificativa de decisão. A lista é FECHADA e só cresce
por COMMIT PREP (o mesmo rito da lista de mutantes). Cada item tem a razão e a fonte.
| # | Afirmação proibida | Porquê | Fonte da refutação |
| --- | --- | --- | --- |
| P-01 | "O limite do plano Zero Trust free é 50 usuários" | reportado por terceiros, ausente das páginas oficiais da Cloudflare | 03-ONDAS §2; 07-COMUNIDADE §1.3 |
| P-02 | Benchmarks do jcode | não corroborados pelo npm nem pelo repo oficial | 03-ONDAS §2; 08-PESQUISA §5.3 |
| P-03 | Pacote pi2dsh | não corroborado | 03-ONDAS §2 |
| P-04 | "Quick tunnel não suporta SSE" | refutada empiricamente: POST text/event-stream chegou em streaming real; o buffering afeta GET/EventSource; o harness usa WebSocket no downlink | 03-ONDAS §2; 08-PESQUISA §1.2; cloudflared issue #1449 |
| P-05 | "Quem tem o token do bot contorna a allowlist" | falso neste desenho: o token autentica chamadas de SAÍDA; a ação destrutiva vem de update de ENTRADA (long polling não tem endpoint para forjar) | 03-ONDAS §2; 02-SEGURANCA §12.2 |
| P-06 | "drop_pending_updates é parâmetro de getUpdates" | NAO CONFIRMADO (S8): é parâmetro de setWebhook/deleteWebhook; o bot.start do grammY traduz-se em deleteWebhook | docs/spikes/telegram.md; 08-PESQUISA §8:11-b (D9) |
| P-07 | "dsh-host-subprocess existe" / "ctx.webServer"/"spawn(cmd,args,opts)"/"dsh-host-frontend" | nomes refutados pelos .d.ts reais (B0): o real é dsh-subprocess(+local), spawn(spec), dsh-host-frontend-static; o serviço web do harness 0.1.1-rc.1 | 03-ONDAS §2; 02-SEGURANCA §12.6; docs/spikes/api-dsh.md |
| P-08 | "O ASVS 5.0 §6.5.2 autoriza SHA-256 em vez de Argon2 para tokens de 128 bits" | errata: para tokens de 128 bits CSPRNG o sha256 é a escolha correta do PROJETO, não uma autorização do ASVS; o ASVS §6.5.2 fala de armazenamento de senha | 02-SEGURANCA §12.1 |
| P-09 | "URLs de quick tunnel são indexadas por motores de busca" | refutada por medição (urlscan) | 02-SEGURANCA §12.4; 08-PESQUISA §7.3 |
| P-10 | "child.kill() nunca basta quando há shell intermediário" | generalização refutada: com detached+grupo POSIX o kill(-pid) basta; a exceção é documentada por caso | 02-SEGURANCA §12.5; 08-PESQUISA §4.2 |
| P-11 | "O plugin tem N dependências de runtime" (qualquer N > 0 para o HOST) | a alegação correta (D23): UMA dependência de runtime DIRETA (grammy 1.45.1), carregada SÓ pelo worker; dependencies do plugin HOST vazias; o grammY arrasta node-fetch@2 TRANSITIVO — a pilha HTTP do worker inclui node-fetch@2 e o THREAT-MODEL tem de o dizer | 09-DECISOES §D23; 06-REPO-E-CI §10 |
| P-12 | "O cookie Secure não funciona em http://127.0.0.1" | refutada (S10 CONFIRMADO): o navegador aceita e reenvia __Host-; Secure emitido por origem HTTP de loopback | docs/spikes/superficie-ui.md |
| P-13 | "Existe campo de compatibilidade no package.json/cordis.patch.yml lido pelo DSH" | NAO CONFIRMADO: a faixa suportada é documentação + asserção em runtime (adapter), não contrato declarativo | 06-REPO-E-CI §11.2 |
Regras: (1) qualquer número citado em material público tem linha correspondente em
08-PESQUISA-E-FONTES §8 com URL e data; (2) um item só sai daqui por medição nova com
evidência arquivada num spike; (3) reutilizar uma frase proibida "entre aspas" também é
violação — a frase não pode aparecer de forma nenhuma.
## Verificação do COMMIT PREP 7 (registo)
- origin: https://github.com/frederico-kluser/deepseek-harness-mobile.git (adição externa do usuário, documentada na Onda 2) — CONFERIDO.
- B0: build verde contra @deepseek-ai/* REAIS re-verificado — o upstream publicou 0.1.1-rc.1 e a faixa foi revista (N=0.1.1-rc.*, N-1=0.1.0-rc.*; types/ regenerados byte-exact; API aditiva; CONTRACT-001/008 atualizados) — fix w6-fix-upstream-011rc (e95da74).
- B1 (dsh.bundle): decisão MEDIDA registada no package.json (//dsh): bundle com .patch (o gate aceita {} mas o produto não ativa). CONFERIDO.
- B6 (SECURITY.md + PVR): SECURITY.md existe (T1.4); Private Vulnerability Reporting = configuração da UI do GitHub (humano), registada como passo pós-onda.
- Nome npm dsh-guarded-bot-orchestrator: npm view = E404 (LIVRE) em 2026-08-20 — a reserva (0.0.1 stub, T1.4) NÃO está no registry; reserva pendente de credenciais de publicação (humano/CI). Risco de name-squatting registado. (histórico: o pacote foi renomeado para `dsh-guard-messenger`; a reserva passa a aplicar-se ao nome novo.)
- exports+repository: já no estado-alvo (types primeiro/default por último; repository git+https exato) — CONGELADOS para a Onda 7 (T7.1).
- Texto-base do README: presente — CONGELADO para T7.4.

NOTA DE REFINAMENTO (orquestrador): os IDENTIFICADORES refutados (ctx.webServer,
dsh-host-subprocess, spawn(cmd,args,opts), dsh-host-frontend) NAO sao padroes do
PROIBIDO.md: sao nomes tecnicos que aparecem legitimamente no README (o plugin
intercepta ctx.webServer) e em tabelas de correcao — cobertos pelo invariante de grep
"fora de tabela de correcao" (05-QUALIDADE 10, item D5). Este ficheiro contem SO as
ALEGACOES proibidas (frases completas) — uma por linha, formato -f.
