# Calibragem de expectativa — material de divulgação

> **O que é:** a tabela de números de expectativa para o lançamento (estrelas, downloads,
> atenção no Show HN). Serve para calibrar o tom de todo o material em
> docs/divulgacao/ e para definir metas **realistas e honestas** — nunca uma promessa.
>
> **Fonte canônica única:** 08-PESQUISA-E-FONTES.md §6.1 (a 'Calibração de expectativa',
> linhas 773–778). Todos os números abaixo apontam para a linha exata. Números de Show HN
> vêm de fonte **não reacessível** (gap **L10**): tratar **sempre** como estimativa, nunca
> como meta contratual (08 §6.1 + L10).

---

## Adoção no repositório (estrelas) — fonte: plugins.json (awesome-dsh-plugin)

Fonte: 08-PESQUISA-E-FONTES.md **§6.1, linhas 773–774** — 'do plugins.json inteiro':
mediana de 2 estrelas, p90 = 15, p99 = 710. _(plugins.json catalogado em 2026-08-19.)_

| Medida | Valor | Linha em 08 §6.1 |
|---|---|---|
| Mediana de estrelas por plugin | **2** | L773–774 |
| **p90** de estrelas | **15** | L773–774 |
| **p99** de estrelas | **710** | L773–774 |

> **Leitura honesta (linha 775):** '15 estrelas já é p90' — alcançar p90 já coloca o
> plugin acima de 90% do registro. Não usar '2★' como envergonhamento nem '710' como meta.

## Publicação no npm e downloads

Fonte: 08 **§6.1, linha 774** — 'Só 38% publicam no npm; entre esses, mediana de 514
downloads/semana'.

| Medida | Valor | Linha em 08 §6.1 |
|---|---|---|
| Parcela do registro que publica no npm | **38%** | L774 |
| Mediana de downloads/semana (entre os publicados) | **514** | L774 |
| ~p75 de downloads/semana (meta realista) | **1.000** | L775 |

## Show HN (atenção) — FONTE NÃO REACESSÍVEL (L10)

Fonte: 08 **§6.1, linhas 776–778**. Estes números vêm do estudo asof.app sobre Show HN,
que retornou **ECONNREFUSED** (gap **L10** em 08 §9). **Não são confirmáveis por fonte
pública neste momento.** Tratar como ordem de grandeza, nunca como meta.

| Medida | Valor | Linha em 08 §6.1 | Confiança |
|---|---|---|---|
| Mediana de pontos de um Show HN | **2** | L776 | Estimativa (L10) |
| Top 6% de pontos | **50** | L776 | Estimativa (L10) |
| ~estrelas por upvote | ~1,4 | L776 | Estimativa (L10) |
| Parcela do impacto nas primeiras 48 h | ~92% | L776 | Estimativa (L10) |
| Show HN concorrentes por dia | ~200 | L777 | Estimativa (L10) |
| Janela: segunda 00:00 UTC (chance de 50+) | ~10,8% | L777–778 | Estimativa (L10) |
| Pior janela: quinta 06:00 UTC (chance de 50+) | ~2,6% | L777–778 | Estimativa (L10) |

> **Regra de uso:** qualquer destes números, se citado em material público, deve repetir a
> ressalva de que é estimativa de fonte não reacessível (evita a regra do lastro de 07 §10 —
> 'o número que um comentarista refuta em cinco minutos').

---

## Como esta calibração entra nos materiais

| Material | Usa | Como |
|---|---|---|
| awesome-dsh-plugin.md | **Não** usa números de expectativa | a entrada é factual/código; calibração não entra na linha única |
| show-your-plugins.md | Não explicitamente | tom honesto, sem prometer tração |
| show-hn.md | Não no corpo | escolha da janela (segunda 00:00 UTC) usa a estimativa; o texto não cita nada refutável |

## Full ledger (número → fonte com URL/data)

| Número | Fonte | Data |
|---|---|---|
| Mediana 2★, p90 15, p99 710 | awesome-dsh-plugin/plugins.json (via 08 §6.1 L773–774) | 2026-08-19 |
| 38% publicam no npm; mediana 514/semana | idem §6.1 L774 | 2026-08-19 |
| ~p75 = 1.000 downloads/semana | idem §6.1 L775 | 2026-08-19 |
| HN: mediana 2 pontos; top 6% = 50 | asof.app (08 §6.1 L776; **L10** não reacessível) | estimativa |
