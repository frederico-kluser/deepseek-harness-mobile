# manual-runs/ — registo dos roteiros manuais M1..M7

Os roteiros **M1..M7** de [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) são a camada
manual pré-release. São corridos **por uma pessoa**, antes de cada release, uma vez
com o resultado **por passo** registado. Um roteiro que falhe bloqueia o release.

## Como usar

1. Copia o (ou cria a partir deste) ficheiro de registo `AAAA-MM-DD.md` para cada
   execução (ex.: `2026-08-25.md`).
2. Corre cada roteiro M1..M7 na ordem; para cada passo, marca ✅/❌ e anota o que viste.
3. Qualquer ❌ vira uma issue com repro (redigida de segredos) antes do release.
4. Mantém o registo assinado/revisto na tag de release.

> **M0 — pré-requisitos:** máquina Linux com DSH instalado, `cloudflared` **verificado por
> checksum**, conta Telegram e celular com dados móveis (**não** o Wi-Fi de casa — a rede
> local mascara o teste inteiro).

## Os roteiros

- [M1 — Onboarding do Telegram do zero](M1-onboarding-telegram.md) (10 min)
- [M2 — Primeiro túnel](M2-primeiro-tunel.md) (8 min)
- [M3 — Desligar pelas duas superfícies](M3-desligar-duas-superficies.md) (5 min)
- [M4 — Falhas reais](M4-falhas-reais.md) (7 min)
- [M5 — Segurança na prática](M5-seguranca.md) (7 min)
- [M6 — Streaming e canal de downlink](M6-streaming-downlink.md) (5 min)
- [M7 — Ciclo de vida](M7-ciclo-vida.md) (3 min)

Total: ~45 min. Tempo é do release, não do CI — a rede real e o Telegram real não se simulam.

## O critério real de M1

M1 termina com uma pessoa que **nunca viu o projeto** a fazer os passos 1→11 sozinha,
sem perguntar nada ao autor. Isso é o teste de usabilidade do onboarding.
