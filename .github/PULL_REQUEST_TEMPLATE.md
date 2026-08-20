<!--
  Obrigado pelo PR. A lista abaixo é curta de propósito: cada linha existe por causa de um
  erro real. Apague o que não se aplica e explique o que ficar por marcar.

  Se este PR corrige uma vulnerabilidade, PARE: correção de segurança não entra por PR
  público antes do advisory. Veja SECURITY.md.
-->

## O que muda e por quê

<!-- Uma mudança por PR. Ligue à issue: "Closes #123". -->

## Como verificar

<!-- Os comandos exatos que um revisor corre para ver o antes e o depois. -->

```console
$
```

## Lista de verificação

- [ ] O gate passa localmente: `pnpm run typecheck`, `pnpm run build`, `pnpm run test`.
- [ ] Escrevi o teste que falha **antes** da correção e mostrei-o a falhar acima.
- [ ] Nenhum ficheiro de código passa de **400 linhas**.
- [ ] **Não alarguei o bind** para além do loopback, nem tornei essa política configurável.
- [ ] **Não removi nem tornei opcional a autenticação**, em nenhum caminho.
- [ ] **Não ampliei o escopo do portão sem dizer**: se rotas guardadas, `fallback` ou `upgrade`
      mudaram de comportamento, está descrito acima.
- [ ] **Nada de segredo em log nem em `argv`**: credencial, digest, token do bot, cookie,
      identificador de sessão e URL do túnel passam pela camada de redação.
- [ ] Sem `?? valorPadrao` silencioso em caminho de política de segurança — a convenção é falhar
      ruidosamente no carregamento.
- [ ] Nenhuma dependência de runtime nova (ou: há uma, e a justificação está escrita acima).
- [ ] Não inventei API do host: todo símbolo `@deepseek-ai/*` que usei está nos `.d.ts` publicados.
- [ ] Não reintroduzi nome morto (`/__mobile`, `/__gate`, `ADMIN_USER`, `ADMIN_PASS`,
      `@deepseek-ai/dsh-host-subprocess`).
- [ ] Todo número que afirmei tem fonte citada.
- [ ] Documentação atualizada se mudei configuração, rota ou comportamento observável.
- [ ] Entrada de changelog adicionada, se o repositório já a exigir (mudanças em `src/**` ou no
      manifesto). Impacto de segurança leva o prefixo `SECURITY:`.
