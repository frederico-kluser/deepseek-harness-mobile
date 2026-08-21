# COMPATIBILITY.md -- compatibilidade com o upstream @deepseek-ai/dsh

> **Gerado por** `scripts/gen-compat-table.mjs` a partir de `dsh-compat.yml`.
> **NUNCA edite este ficheiro a mao.** Para mudar a faixa suportada, edite
> `dsh-compat.yml` na raiz do repositorio e re-corra o gerador:
>
> ```bash
> node scripts/gen-compat-table.mjs
> ```

O upstream `@deepseek-ai/dsh` esta em developer preview (0.x.rc). A politica de suporte e
**N/N-1 rc lines**: a linha de release corrente do upstream mais a linha anterior. Mais
que duas linhas de rc vira matriz insustentavel para um projeto de um mantenedor.

**Faixa global suportada:** `0.1.0-rc.7 .. 0.1.1-rc.1`.

A verificacao em runtime e por FORMA do servico (`src/dsh/adapter.ts` confere,
por exemplo, `typeof ctx.webServer?.registerFallback === "function"`), nao por
string de versao: o upstream renomeia servico sem bumpar major (esta em 0.x). Se faltar um
simbolo, o plugin falha no carregamento com mensagem que nomeia o simbolo ausente e a faixa
testada. Os tipos `types/` sao regenerados byte-exact dos tarballs npm pinnedos e o
contrato roda em `test:contract`.

| Versao do plugin | Faixa de rc do DSH | Status | Rotulo |
| --- | --- | --- | --- |
| 0.1.0 | 0.1.1-rc.1 | :white_check_mark: supported | N |
| 0.1.0 | 0.1.0-rc.* | :white_check_mark: supported | N-1 |
| — | 0.1.0-rc.0 .. 0.1.0-rc.6 | :warning: deprecated | anterior |

### Notas por linha

- **N** (0.1.1-rc.1) - supported.   Linha corrente. `types/` regenerados byte-exact contra os tarballs npm   publicados (w6-fix-upstream-011rc); CONTRACT-001/008 atualizados.
- **N-1** (0.1.0-rc.*) - supported.   Linha anterior, mantida por política N/N-1. É a mínima da faixa   `supported-range` (ex.: `0.1.0-rc.7`, tarball da verificação E1–E4).
- **anterior** (0.1.0-rc.0 .. 0.1.0-rc.6) - deprecated.   Fora da faixa testada. Atualize: a discussão #853 (RCE não autenticada   do plano de controlo) foi verificada em 0.1.0-rc.6; a faixa sobre a qual   o teste de segurança roda é a `supported-range`.

---

_Gerado por scripts/gen-compat-table.mjs. Nao editar a mao._
