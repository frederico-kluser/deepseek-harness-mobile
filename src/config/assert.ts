/**
 * `assertValidConfig` e os assertores primitivos que ela usa.
 *
 * Nao ha `?? valor_por_omissao` em lado nenhum: uma chave em falta significa que
 * o `cordis.patch.yml` foi mal escrito. Preencher em silencio transformaria um
 * erro de configuracao num buraco de seguranca silencioso. E a regra Q-3.
 *
 * PORQUE ISTO E A UNICA REDE CONTRA O FAIL-OPEN DO MANIFESTO (medido por T1.3 e
 * T1.4). O motor de patches do `dsh-app-boot` tem DOIS caminhos de descarte
 * silencioso, ambos com exit 0:
 *
 *   1. `id` que nao casa numa entrada de `override` -> imprime
 *      `patch: entry "<id>" not found` e continua, deixando em pe o valor DE
 *      ORIGEM;
 *   2. `name` que nao casa (`lib/index.js:96-99`) -> `warn` + `continue`, e a
 *      entrada e simplesmente ignorada.
 *
 * Uma colisao de `insert` produz DUAS linhas, tambem em silencio. Ou seja: o
 * manifesto NAO falha alto por si. O que se segue e o que falha.
 *
 * A assinatura de "a entrada foi descartada" e precisamente a ausencia das
 * chaves proprias deste plugin (`realm`, `allowedHosts`, `trustedRemotes`,
 * `guardedPrefixes`, `deniedPermissions`, `worker`): qualquer uma em falta lanca
 * aqui, com o nome da chave na mensagem.
 *
 * NOTA sobre a semantica do `replace` (corrigida): e SHALLOW MERGE das chaves de
 * topo da entrada (`lib/index.js:100-103`), nao *whole-entry replace*. So o
 * objeto `config`, quando fornecido, e substituido inteiro -- e e por isso que
 * uma chave omitida DENTRO de `config` continua a ser uma chave apagada.
 */

import { statSync } from 'node:fs'

import { PLUGIN_NAME } from '../errors.ts'
import { resolveWorkerCwd, type Config } from './schema.ts'

/**
 * Caracteres proibidos no `realm`.
 *
 *   - aspas e barra invertida quebrariam a quoted-string do cabecalho
 *     `WWW-Authenticate`;
 *   - o intervalo U+0000..U+001F mais U+007F cobre CR/LF e restantes controlos
 *     (injecao de cabecalhos);
 *   - tudo acima de U+00FF e recusado porque um cabecalho HTTP/1.1 viaja em
 *     Latin-1. Um `realm` com caracteres fora desse intervalo (um emoji, um
 *     alfabeto nao latino) passava na validacao e so rebentava em tempo de
 *     execucao, DENTRO do `res.writeHead(401, ...)`, com `ERR_INVALID_CHAR`. O
 *     efeito pratico e o pior possivel: em vez do 401 com o desafio, o cliente
 *     recebe uma resposta vazia e o socket fechado -- a barreira continua a
 *     barrar, mas deixa de ser legivel e o operador nao percebe porque.
 *     Recusa-se no arranque, como manda o "fail loud at load".
 *
 * Espacos SAO permitidos -- 'Secure DSH Interface' e um realm legitimo.
 */
// Os controlos U+0000..U+001F e U+007F sao o ALVO desta validacao (CR/LF =
// injecao de cabecalho), nao um acidente: e o caso legitimo que a propria doc
// do `no-control-regex` preve. Desativacao escopada a ESTA linha.
// oxlint-disable-next-line no-control-regex
const UNSAFE_REALM_PATTERN = /["\\\u0000-\u001f\u007f]|[^\u0000-\u00ff]/u

/**
 * Lados de credencial que NUNCA sao aceitaveis.
 *
 * `undefined` e `null` sao exatamente as strings que uma interpolacao
 * descuidada produz a partir de uma variavel de ambiente ausente:
 *
 *     Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`)
 *       -> 'undefined:undefined' -> 'dW5kZWZpbmVkOnVuZGVmaW5lZA=='
 *
 * Isso NAO e uma credencial invalida -- e uma credencial VALIDA, FIXA e
 * derivavel por qualquer pessoa que conheca o padrao.
 */
const PLACEHOLDER_CREDENTIAL_PARTS = new Set(['undefined', 'null', 'nan', 'nil', 'none'])

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[${PLUGIN_NAME}] config.${path} tem de ser uma string nao vazia.`)
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`[${PLUGIN_NAME}] config.${path} tem de ser um array de strings.`)
  }
}

function assertPositiveNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[${PLUGIN_NAME}] config.${path} tem de ser um numero positivo finito.`)
  }
}

/**
 * Valida o PAR DESCODIFICADO de `encodedAuthString` (defesa em profundidade).
 *
 * PORQUE AQUI TAMBEM, se o `cordis.patch.yml` ja lanca quando `ADMIN_USER` ou
 * `ADMIN_PASS` faltam: porque o manifesto e apenas UM dos caminhos por onde a
 * configuracao pode chegar. Camadas de precedencia superiores (Home, `--patch`
 * da CLI) e qualquer outro carregador podem entregar este `config` sem passar
 * pelas guardas do YAML. `assertNonEmptyString` aprovava alegremente
 * `dW5kZWZpbmVkOnVuZGVmaW5lZA==` -- uma string nao vazia, e portanto "valida".
 * A unica verificacao que apanha a credencial universal e descodificar e olhar
 * para os dois lados.
 */
function assertUsableCredential(encodedAuthString: string, path: string): void {
  const decoded = Buffer.from(encodedAuthString, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')

  if (separator === -1) {
    throw new Error(
      `[${PLUGIN_NAME}] config.${path} tem de ser base64 de 'utilizador:senha' (RFC 7617). ` +
        'O valor entregue nao descodifica para um par separado por ":".',
    )
  }

  const user = decoded.slice(0, separator).trim()
  const pass = decoded.slice(separator + 1).trim()

  if (user.length === 0 || pass.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] config.${path}: o par descodificado tem utilizador ou senha vazios. ` +
        'Ambos os lados de "utilizador:senha" sao obrigatorios.',
    )
  }

  for (const [label, part] of [
    ['utilizador', user],
    ['senha', pass],
  ] as const) {
    if (PLACEHOLDER_CREDENTIAL_PARTS.has(part.toLowerCase())) {
      throw new Error(
        `[${PLUGIN_NAME}] config.${path}: o ${label} descodificado e o literal '${part}'. ` +
          'Isto e a assinatura de uma variavel de ambiente ausente interpolada num ' +
          'template (ADMIN_USER/ADMIN_PASS por definir) e produz uma credencial fixa, ' +
          'publicamente derivavel. Recuso arrancar: define as variaveis e reinicia.',
      )
    }
  }
}

/**
 * Exige que um caminho exista E seja um diretorio.
 *
 * PORQUE E VALIDACAO DE ARRANQUE E NAO "problema do runtime": um `worker.cwd`
 * inexistente faz o `spawn` falhar, e uma falha de spawn NAO produz uma saida
 * normal -- ela REJEITA a promessa `done` do handle ("rejects only for
 * spawn-level failures"). Antes da correcao desta onda isso significava um
 * worker permanentemente morto sem qualquer reinicio. Agora a falha de spawn e
 * tratada, mas continua a ser muito melhor recusar a configuracao no arranque,
 * com uma mensagem que nomeia o caminho, do que gastar o orcamento de reinicios
 * a repetir um erro que nunca se resolve sozinho.
 */
function assertExistingDirectory(value: string, path: string): void {
  let isDirectory: boolean
  try {
    isDirectory = statSync(value).isDirectory()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[${PLUGIN_NAME}] config.${path} ('${value}') nao existe ou nao e acessivel: ${reason}. ` +
        'O spawn do worker falharia com ENOENT a cada tentativa.',
    )
  }

  if (!isDirectory) {
    throw new Error(`[${PLUGIN_NAME}] config.${path} ('${value}') existe mas nao e um diretorio.`)
  }
}

/** Valida a configuracao INTEIRA no arranque. */
export function assertValidConfig(config: Config): void {
  // `encodedAuthString` e OPCIONAL desde que o `cordis.patch.yml` passou a ser
  // Camada 1 / Bundle: uma credencial nao pode viver num ficheiro empacotado
  // (D19). Ausente NAO e erro de arranque -- e a politica fail-closed levada ao
  // limite: sem credencial configurada, nenhuma requisicao passa a barreira (ver
  // `verifyBasicAuth`). Presente, continua a ser validada com o mesmo rigor,
  // incluindo o par descodificado.
  if (config.encodedAuthString !== undefined) {
    assertNonEmptyString(config.encodedAuthString, 'encodedAuthString')
    assertUsableCredential(config.encodedAuthString, 'encodedAuthString')
  }

  assertNonEmptyString(config.realm, 'realm')

  // O realm entra literalmente num cabecalho de resposta. Aspas, barras
  // invertidas e caracteres de controlo permitiriam injecao de cabecalhos
  // (CRLF) -- recusa-se no arranque em vez de "higienizar" a cada pedido.
  if (UNSAFE_REALM_PATTERN.test(config.realm)) {
    throw new Error(
      `[${PLUGIN_NAME}] config.realm nao pode conter aspas, barras invertidas nem caracteres de controlo.`,
    )
  }

  assertStringArray(config.allowedHosts, 'allowedHosts')
  if (config.allowedHosts.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] config.allowedHosts nao pode estar vazio (nenhum bind seria valido).`,
    )
  }

  // `trustedRemotes` PODE estar vazio: e a politica fail-closed (nega tudo).
  assertStringArray(config.trustedRemotes, 'trustedRemotes')

  assertStringArray(config.guardedPrefixes, 'guardedPrefixes')

  // Um prefixo sem `/` inicial NUNCA casa com um caminho de rota (que comeca
  // sempre por `/`): `'api'` declara exatamente nada. Continua a ser recusado no
  // arranque mesmo depois de a barreira passar a guardar a superficie inteira,
  // porque a lista e o INVENTARIO do plano de controlo consumido por
  // `src/http/path.ts` -- e um inventario que nao casa com nenhum caminho e uma
  // declaracao falsa, do tipo que parece configurada e nao esta.
  for (const [index, prefix] of config.guardedPrefixes.entries()) {
    if (!prefix.startsWith('/')) {
      throw new Error(
        `[${PLUGIN_NAME}] config.guardedPrefixes[${index}] = '${prefix}' tem de comecar por '/'. ` +
          'Um prefixo sem barra inicial nao casa com caminho nenhum e declara um ' +
          'inventario de plano de controlo vazio sem o dizer.',
      )
    }
  }

  assertStringArray(config.deniedPermissions, 'deniedPermissions')

  if (typeof config.worker !== 'object' || config.worker === null) {
    throw new Error(`[${PLUGIN_NAME}] config.worker tem de ser um objeto.`)
  }

  assertNonEmptyString(config.worker.command, 'worker.command')
  assertStringArray(config.worker.args, 'worker.args')
  // `worker.cwd` e OPCIONAL: um caminho absoluto fixo num manifesto empacotado
  // quebraria toda a instalacao por npm. Ausente resolve para o `worker/` do
  // proprio pacote -- e o caminho RESOLVIDO e validado com o mesmo rigor que o
  // declarado, porque um default que nao existe falha o spawn exatamente como um
  // caminho errado escrito a mao.
  if (config.worker.cwd !== undefined) {
    assertNonEmptyString(config.worker.cwd, 'worker.cwd')
  }
  assertExistingDirectory(resolveWorkerCwd(config), 'worker.cwd')

  assertNonEmptyString(config.worker.token, 'worker.token')

  // `graceMs` e obrigatorio em `SubprocessSpawnSpec` e o assento NAO aplica
  // defaults ("this seam applies no defaults"). Sem validacao, um YAML sem a
  // chave entregava `undefined` ao `spawn` e a escalada de terminacao ficava
  // indefinida -- decisao de ciclo de vida de processo, portanto sem `??` (Q-3).
  assertPositiveNumber(config.worker.graceMs, 'worker.graceMs')

  const { backoff } = config.worker
  if (typeof backoff !== 'object' || backoff === null) {
    throw new Error(`[${PLUGIN_NAME}] config.worker.backoff tem de ser um objeto.`)
  }

  assertPositiveNumber(backoff.initialDelayMs, 'worker.backoff.initialDelayMs')
  assertPositiveNumber(backoff.maxDelayMs, 'worker.backoff.maxDelayMs')
  assertPositiveNumber(backoff.maxAttempts, 'worker.backoff.maxAttempts')
  assertPositiveNumber(backoff.resetAfterMs, 'worker.backoff.resetAfterMs')

  if (backoff.maxDelayMs < backoff.initialDelayMs) {
    throw new Error(
      `[${PLUGIN_NAME}] config.worker.backoff.maxDelayMs (${backoff.maxDelayMs}) ` +
        `nao pode ser inferior a initialDelayMs (${backoff.initialDelayMs}).`,
    )
  }
}
