---
"dsh-guarded-bot-orchestrator": patch
---

Exemplo de changeset para a release 0.1.0 (primeira publicacao publica do plugin:
0.1.x e o ramo de versao enquanto o DSH estiver em developer preview, ver
docs/plano/06-REPO-E-CI.md secao 7.3).

Regras do changeset neste repositorio:
- cada PR que mexe no produto (src/, worker/, test/, cordis.patch.yml) DEVE trazer
  um ficheiro `.changeset/*.md` com um bump explicitamente escolhido — `patch`,
  `minor` ou `major` — porque `1.0.0` so e promessa, nao inferencia de prefixo de
  commit (06-REPO-E-CI.md secao 7.2).
- em `0.x` o `minor` e o bump que quebra instalacao existente; `patch` e o que
  nao quebra (adaptacao a nova rc do DSH, feature retrocompativel, correcao de
  seguranca).
