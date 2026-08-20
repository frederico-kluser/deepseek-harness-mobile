# Como contribuir

Obrigado pelo interesse. Este documento diz **como reportar**, **como propor**, **como montar o
ambiente** e — a parte mais importante num projeto de segurança — **o que nunca é aceite**.

Ao participar, concorda com o [Código de Conduta](CODE_OF_CONDUCT.md).

> **Encontrou uma vulnerabilidade?** Não abra issue. Leia [`SECURITY.md`](SECURITY.md) e use o
> canal privado descrito lá.

---

## 0. Estado do projeto — leia antes de investir tempo

O plugin **ainda não funciona ponta a ponta**. Está em reconstrução ativa: a superfície real da
API do DSH foi levantada pacote a pacote e o código está a ser migrado para ela; o túnel, o bot
do Telegram e o liga/desliga ainda não existem como funcionalidade entregue. Um PR grande neste
momento tem grande probabilidade de colidir com trabalho em curso — **abra uma issue antes de
escrever código**.

---

## 1. Montar o ambiente — quatro comandos

Requer **Node ≥ 24** (o pacote declara `engines`) e `pnpm` via Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
```

O `pnpm-lock.yaml` é autoridade: `--frozen-lockfile` falha se o `package.json` e o lockfile
divergirem, e isso é intencional.

### Os scripts

A lista autoritativa é o bloco `scripts` do `package.json` — confirme com `pnpm run` antes de
assumir que um script existe, porque o conjunto está a crescer nesta fase do projeto.

| Script | O que faz |
| --- | --- |
| `pnpm run typecheck` | `tsc --noEmit` com o `tsconfig.json` (inclui `test/**` e o *smoke test* de tipos). Não emite artefactos. |
| `pnpm run build` | `tsc -p tsconfig.build.json`: compila **apenas** `src/**` e emite `dist/` (JS + `.d.ts`). |
| `pnpm run test` | Suíte com o *test runner* nativo do Node. |
| `pnpm run test:contract` | Testes de contrato contra a superfície tipada dos pacotes `@deepseek-ai/*`. |
| `pnpm run types:fetch` | Rebusca os `.d.ts` reais dos tarballs publicados no npm. |

**Níveis de teste e por que nem todos correm sempre:**

- **unitário e de integração** — sem rede, sem processos externos. Correm sempre, em todo PR.
- **contrato** — validam que os símbolos que usamos ainda existem na superfície publicada do DSH.
  Correm sempre; quando falham, o culpado costuma ser uma `rc` nova a montante, não o seu PR.
- **e2e offline** — sobem o plugin contra dublês locais. **Obrigatórios** em PR: não tocam a rede.
- **live** — sobem um túnel real e falam com serviços de terceiros. São **opt-in** e nunca são
  exigidos num PR: dependem de rede, de credenciais e de um serviço sem SLA, logo falhariam por
  motivos alheios a quem contribui.

---

## 2. Reportar um bug

Use os [modelos de issue](.github/ISSUE_TEMPLATE). O que faz um relato ser resolvido depressa:

- versão do plugin, versão `rc` do DSH, versão do Node e sistema operativo;
- o comando exato e a saída exata — colar `401` esperado *versus* `200` obtido vale mais do que
  três parágrafos de descrição;
- **log redigido**. Antes de colar, retire o token do bot, a senha, o cabeçalho `Authorization`,
  cookies e a URL do túnel.

Se o que quebrou foi uma atualização da `rc` do DSH, use o modelo de **quebra de compatibilidade**
e diga qual símbolo mudou: é o relato mais útil que este repositório recebe.

---

## 3. Propor uma funcionalidade

Abra uma issue com o modelo de funcionalidade **antes** do PR. O modelo tem um campo obrigatório
de **impacto de segurança**, e ele não é decorativo: a pergunta «e se o portão tivesse um modo sem
senha, para facilitar?» aparece regularmente e a resposta está na §5.

---

## 4. Abrir um PR

1. Uma mudança por PR. Refactor e correção de comportamento não viajam juntos.
2. Escreva o teste que falha **antes** da correção, e mostre-o a falhar na descrição do PR.
3. O gate tem de passar. Hoje: `pnpm run typecheck`, `pnpm run build` e `pnpm run test`. Um passo
   de *lint* e um de *changeset* estão a ser adicionados ao repositório — quando existirem,
   passam a ser obrigatórios e o `package.json` mostra-os.
4. **Limite de 400 linhas por ficheiro** de código (`src/**`, `worker/**`, `test/**`,
   `types/**`, `bin/**`). Documentação não conta. Ficheiro que passa disso divide-se.
5. Mudanças em `src/**` ou no manifesto `cordis.patch.yml` exigem entrada de *changelog*
   (`pnpm exec changeset`, assim que o Changesets entrar no repositório). Toda entrada com
   impacto de segurança leva o prefixo `SECURITY:` e diz se exige ação do utilizador — rodar a
   senha, reinstalar o manifesto, derrubar o túnel.
6. Preencha a lista de verificação do [modelo de PR](.github/PULL_REQUEST_TEMPLATE.md). Ela é
   curta de propósito e cada linha existe por causa de um erro real.

### Nomes mortos — não os reintroduza

Estes nomes foram substituídos e **não podem voltar** ao código, aos testes nem à documentação:

| Morto | Vivo |
| --- | --- |
| `/__mobile`, `/__gate` | `/__guard` |
| `ADMIN_USER`, `ADMIN_PASS` | credencial gerada pelo plugin, persistida só como digest |
| `@deepseek-ai/dsh-host-subprocess` (pacote inexistente) | `@deepseek-ai/dsh-subprocess` |

---

## 5. O que nunca é aceite num PR

Sem eufemismo, porque cada um destes já foi pedido em projetos equivalentes:

- **alargar o *bind* para além do loopback**, ou tornar a verificação de *bind* configurável de
  forma a admitir `0.0.0.0` / `::`;
- **remover, tornar opcional ou «temporariamente desligar» a autenticação** — em particular
  enquanto houver exposição ativa;
- **enviar a senha, o token ou qualquer segredo pelo Telegram.** Conversa com bot é *cloud chat*:
  sem ponta-a-ponta, com histórico no servidor e sem autodestruição para bots;
- **registar em log credencial, token, cookie, identificador de sessão ou a URL do túnel** sem
  passar pela camada de redação;
- **`?? valorPadrao` silencioso em caminho de política de segurança.** A convenção deste projeto,
  herdada do DSH, é falhar ruidosamente no carregamento — arrancar degradado em silêncio é o
  contrário de fail-closed;
- **passar segredo por `argv`.** `/proc/<pid>/cmdline` é legível por qualquer processo local;
  segredo vai por ambiente ou por ficheiro com permissões restritas;
- **dependência de runtime nova sem justificação escrita no PR** — cada uma é superfície de
  *supply chain* que os utilizadores herdam;
- **inventar API do host que os `.d.ts` publicados não declaram.** Se a superfície tipada não
  oferece, a resposta certa é documentar a limitação, não fingir que existe;
- **afirmar número sem fonte** em código, comentário ou documentação. Se não der para citar de
  onde veio, não entra.

---

## 6. O que esperar de nós

Projeto de uma pessoa, com prazos declarados e honestos:

- relato de **segurança**: primeira resposta em 24 horas;
- **restantes issues e PRs**: primeira resposta em até 1 semana, ainda que seja «recebi, vejo na
  sexta»;
- **30 dias sem qualquer resposta**: considere o projeto sem manutenção e faça *fork*. A licença
  MIT permite-o, e é preferível a esperar.

Convite a co-mantenedor a partir de **dois PRs integrados** — um projeto de segurança com fator de
autocarro igual a 1 é um risco que os utilizadores herdam.
