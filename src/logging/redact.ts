/**
 * `redact()` -- mascara segredos antes de qualquer texto chegar ao log.
 *
 * PORQUE EXISTE, E PORQUE JA AGORA (Q-4: "segredo nunca em log"): o supervisor
 * encaminha stdout/stderr do worker para o logger do DSH. Esse worker e um
 * cliente HTTP do Telegram, e a API do Telegram poe o token DENTRO do caminho do
 * URL (`https://api.telegram.org/bot<n>:<token>/getUpdates`). Basta o bot
 * imprimir um erro de rede -- o que qualquer cliente HTTP faz por omissao -- para
 * o token do bot ficar em claro no log do plano de controlo. Nao e hipotetico:
 * e o formato normal de uma mensagem de excecao de `requests`/`httpx`.
 *
 * DUAS CAMADAS, e a ordem importa:
 *   1. LITERAIS CONHECIDOS. Se ja sabemos o segredo (o `worker.token` vem da
 *      configuracao), a substituicao literal e exata e nao depende de a agulha
 *      ter o formato esperado. E a camada fiavel.
 *   2. FORMAS. Para o que nao conhecemos: a forma de um token de bot, e o VALOR
 *      de um cabecalho `Authorization`/`Cookie` quando o texto e um dump de
 *      pedido. E heuristica, e esta declarada como tal -- apanha o caso comum,
 *      nao substitui a camada 1.
 *
 * O QUE ESTAVA EM FALTA E JA NAO ESTA (costura da Onda 3). Este cabecalho dizia
 * que o `mk` do link magico e o URL do tunel nao estavam aqui porque as formas
 * ainda nao tinham sido fixadas, e que os donos as acrescentariam. Foram
 * fixadas -- T2.2 fixou o `mk`, T3.1/T3.2 fixaram o URL do quick tunnel -- e
 * estao agora em {@link SECRET_SHAPES}, com o caminho do `$HOME` a acompanhar.
 *
 * ATE ENTAO ELAS VIVIAM EM DUPLICADO, e essa e a razao de a promocao ser uma
 * correccao e nao arrumacao: `maskAuditText` (`src/audit/format.ts`) tinha-as, e
 * quem chamasse `redact()` diretamente -- que e TODO o encaminhamento de
 * stdout/stderr de subprocesso, `src/proc/stream-log.ts` -- nao tinha nenhuma.
 * O `cloudflared` imprime a URL do tunel no proprio `stderr` que o supervisor
 * encaminha para o log: a forma faltava exatamente no caminho por onde o
 * segredo passa a cada arranque.
 *
 * O QUE CONTINUA A NAO ESTAR AQUI, e de proposito: as formas que so fazem
 * sentido num log de AUDITORIA (o token de bot CURTO com prefixo `bot`, a cauda
 * de um segredo engolido pela camada 1, e o segredo do plugin em base32). Ver
 * `AUDIT_SHAPES` em `src/audit/format.ts`, que explica cada uma -- sao mais
 * agressivas de proposito, e num log de operador o falso positivo delas custa
 * legibilidade sem comprar nada.
 */

/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export const REDACTED = '[REDACTED]'

/**
 * Comprimento minimo de um literal conhecido para ser mascarado.
 *
 * Um segredo curto (ou vazio, ou um valor de teste como `'x'`) casaria com meio
 * texto e transformava o log em ruido. Abaixo deste limite o valor nao e
 * segredo utilizavel de qualquer forma.
 */
const MIN_LITERAL_LENGTH = 8

/**
 * Formas heuristicas.
 *
 * CONVENCAO: o que sobrevive e `keep` e o resto do casamento vira {@link
 * REDACTED}. `keep: '$1'` preserva o prefixo que NOMEIA o segredo (`mk=`,
 * `Authorization: `) -- ele nao e segredo e sem ele a linha fica ilegivel;
 * `keep: ''` apaga o casamento inteiro, que e o caso das formas em que o
 * proprio texto casado E o segredo (o URL do tunel, o `$HOME`).
 */
const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; keep: string }> = [
  // Token de bot do Telegram: `<id numerico>:<segredo>` -- a forma que viaja
  // dentro do caminho do URL da API. Sem `\b` a abrir: o token aparece colado ao
  // prefixo `bot` (`/bot123:AA.../getUpdates`), onde `t9` NAO e fronteira de
  // palavra e um `\b` fazia a forma nunca casar exatamente no caso real.
  { pattern: /((?<!\d)\d{6,12}:)([A-Za-z0-9_-]{20,})/gu, keep: '$1' },
  // Valor de um cabecalho de autorizacao num dump de pedido. Ate ao fim da
  // linha, e nao `\S+`: o valor de `Basic <credencial>` tem um espaco no meio, e
  // parar no primeiro branco deixava a credencial em claro.
  { pattern: /((?:proxy-)?authorization\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  // Valor de um cookie (o nome pode ficar; o valor nunca).
  { pattern: /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  /*
   * URL DO QUICK TUNNEL. Nao e um endereco publico qualquer: e a CAPACIDADE --
   * quem a tem alcanca a barreira, e por isso ela nunca e persistida
   * (`03-ONDAS.md` 7) e nunca e registada.
   *
   * Cobre a forma `quick` (`*.trycloudflare.com`), a unica cujo dominio se
   * conhece a priori. Um tunel `named` usa o dominio do proprio dono, que
   * nenhuma forma adivinha: esse depende da camada 1 (o URL entra em
   * `knownSecrets`), e e por isso que `openAuditLog` recebe um FORNECEDOR de
   * segredos em vez de uma lista fixa -- o URL muda a cada arranque.
   *
   * SEM ancora de fronteira, e isso e uma correccao medida: um `(\b)` a abrir
   * capturava a string vazia e so servia para FALHAR -- em
   * `url1https://x.trycloudflare.com` nao ha fronteira de palavra entre `1` e
   * `h`, e o URL sobrevivia inteiro. Um `https://` ja e auto-delimitado.
   */
  { pattern: /https?:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com[^\s"']*/giu, keep: '' },
  /*
   * `mk` DO LINK MAGICO: 128 bits, TTL 120 s, uso unico (T2.2). Curto e
   * descartavel, mas dentro da janela e uma sessao autenticada inteira -- e um
   * log e exatamente o sitio onde um valor de 120 segundos sobrevive anos.
   *
   * O lookbehind evita casar o sufixo de outra chave (`webhook_mk=`). Cobre
   * `?mk=`, `&mk=` e `#mk=` (o link magico pode levar o segredo no FRAGMENTO,
   * que e a variante que nem chega ao servidor).
   */
  { pattern: /((?<![\w-])mk=)([^&\s"']+)/giu, keep: '$1' },
  /*
   * O `$HOME` -- E SO O `$HOME`.
   *
   * >>> A REGRA ESCOLHIDA, E PORQUE NAO A LARGA <<<
   * Mascarar caminhos e a forma mais facil de destruir uma mensagem de erro
   * util. A versao anterior desta forma (`maskAbsolutePaths`, um remendo local
   * em `src/panel/api.ts`) comia QUALQUER caminho absoluto com tres ou mais
   * segmentos: `/usr/lib/node_modules/...`, `/opt/bin/cloudflared`,
   * `/etc/hosts` -- estrutura que e igual em todas as maquinas, que nao
   * identifica ninguem, e que e precisamente o que diz ao operador onde
   * procurar. Uma mensagem que sobra como "nao encontrei [REDACTED]" nao vale
   * mais do que mensagem nenhuma.
   *
   * O que identifica o UTILIZADOR e o `$HOME`: `/home/<nome>`, `/Users/<nome>`
   * (darwin -- `package.json` declara `os: [linux, darwin]`) e `/root`. E isso,
   * e so isso, que sai. O que fica por baixo -- `[REDACTED]/.dsh/audit.log` --
   * continua a dizer QUAL o ficheiro sem dizer DE QUEM.
   *
   * PORQUE IMPORTA: `TunnelFailure.message` e mostrada ao dono no painel E
   * enviada por Telegram, ou seja atravessa um terceiro. O nome de conta de
   * quem corre o DSH nao tem de fazer essa viagem.
   *
   * O `~` NAO entra: ele ja e a forma anonima do mesmo caminho.
   */
  { pattern: /(?<![\w.~-])\/(?:(?:home|Users)\/[^/\s"'<>)\];,:]+|root)(?![\w-])/gu, keep: '' },
]

/** Escapa um literal para uso seguro dentro de uma expressao regular. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Devolve `text` com os segredos mascarados.
 *
 * @param text texto arbitrario, tipicamente vindo de um processo de terceiros.
 * @param knownSecrets literais que sabemos ser segredos (ex.: `worker.token`).
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < MIN_LITERAL_LENGTH) continue
    result = result.replace(new RegExp(escapeForRegExp(secret), 'gu'), REDACTED)
  }

  for (const { pattern, keep } of SECRET_SHAPES) {
    // `lastIndex` de uma regex global e estado partilhado entre chamadas; o
    // `replace` reinicia-o, mas construir a copia torna a funcao reentrante.
    result = result.replace(new RegExp(pattern.source, pattern.flags), `${keep}${REDACTED}`)
  }

  return result
}
