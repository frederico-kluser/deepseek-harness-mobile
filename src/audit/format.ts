/**
 * Serializacao de `{ts, evento, resultado, ip_normalizado, sessao_id_hash}`.
 *
 * DONO: T2.4. Par de `./log.ts`: aqui decide-se O QUE fica escrito, la decide-se
 * COMO e ONDE fica escrito. A separacao existe porque as duas metades falham por
 * razoes diferentes -- esta falha por vazar um segredo, aquela por perder uma
 * linha -- e misturar as duas num ficheiro so faria com que nenhuma delas fosse
 * testavel isoladamente.
 *
 * TRES INVARIANTES, e todas sao testadas:
 *
 *   1. LISTA BRANCA DE CHAVES, NAO LISTA NEGRA. O registo escrito tem exatamente
 *      as cinco chaves acima, sempre, pela mesma ordem. Um `AuditEvent` que traga
 *      campos a mais (de codigo futuro, ou de um `JSON.parse`) perde-os -- e essa
 *      e a resposta a "o log grava o segredo tentado?": nao ha caminho por onde
 *      um campo nao previsto chegue ao ficheiro, mesmo que alguem o acrescente.
 *
 *      ATE ONDE VAI, e nao mais: a lista branca cobre as CHAVES, nao o CONTEUDO
 *      de `evento`, que e uma string livre e vai para o ficheiro. Do conteudo
 *      cuidam as mascaras -- e mascara e heuristica: apanha as formas fixadas
 *      (token de bot, `mk`, URL do tunel `quick`, segredo em base32 MAIUSCULO),
 *      nao apanha o que nao tem forma (um segredo re-codificado, um token curto
 *      sem prefixo `bot`, a mesma base32 em minusculas). Isso e defesa em
 *      PROFUNDIDADE, nao fronteira: o `evento` e escrito pelo plugin a partir do
 *      vocabulario fechado de T5.4, nunca por quem ataca. Quem la puser um
 *      segredo em claro poe-no no ficheiro, e nenhuma regex o salva -- a camada
 *      fiavel para isso e {@link maskAuditText} com o literal em `knownSecrets`.
 *
 *   2. UMA LINHA E UMA LINHA. O corpo e JSON, e `JSON.stringify` escapa `\n`
 *      para `\\n`. Um `evento` que contenha uma quebra de linha e um registo
 *      forjado -- injecao de log -- nao consegue portanto produzir uma segunda
 *      linha. E por isso que o formato e JSON e nao um `printf` com separadores.
 *
 *   3. MASCARAMENTO ANTES DE SERIALIZAR, nunca depois. Depois seria mascarar
 *      texto ja escapado, onde `\n` e `\\n` e um segredo partido ao meio por um
 *      escape deixaria de casar com a sua forma.
 *
 * PORQUE `redact()` E CHAMADO E NAO COPIADO (`../logging/redact.ts`, T1.1): uma
 * primitiva de mascaramento duplicada e uma primitiva que diverge -- a copia
 * ganha um padrao que o original nao tem, e o autor do original corrige um bug
 * que a copia continua a ter. `redact()` e a camada 1 (literais conhecidos) e a
 * camada 2 (token de bot, `Authorization`, `Cookie`). O que esta AQUI e o que o
 * proprio `redact.ts` declara em falta, por escrito, no seu cabecalho: o `mk` do
 * link magico e o URL do tunel -- formas que na Onda 1 ainda nao existiam. Mais
 * duas que sao desta sub-tarefa: a forma do segredo do plugin, e um apanhado
 * para o token de bot CURTO que a forma de `redact.ts` deixa passar por desenho
 * (ela exige >= 20 caracteres depois dos dois pontos). Ver {@link AUDIT_SHAPES}.
 */

import { createHash } from 'node:crypto'

import type { AuditEvent } from '../contracts/auth.ts'
import { redact, REDACTED } from '../logging/redact.ts'

/**
 * O registo tal como fica no ficheiro. Forma FIXA: as cinco chaves existem
 * sempre, e a ausencia e `null` explicito.
 *
 * PORQUE `null` E NAO A CHAVE AUSENTE: "nao havia IP de cliente fiavel" e um
 * FACTO -- e, depois do spike S2, o facto normal, porque sob `cloudflared` a
 * origem e sempre `127.0.0.1` e `X-Forwarded-For` e forjavel. Omitir a chave
 * tornaria esse facto indistinguivel de "o programador esqueceu-se do campo",
 * que e precisamente a duvida que ninguem consegue resolver seis meses depois a
 * ler um log.
 */
export interface AuditRecord {
  readonly ts: string
  readonly evento: string
  readonly resultado: 'permitido' | 'negado'
  readonly ip_normalizado: string | null
  readonly sessao_id_hash: string | null
}

/** Falha de formatacao: o registo NAO pode ser escrito como esta. */
export class AuditFormatError extends Error {
  override readonly name = 'AuditFormatError'
}

/**
 * Teto do campo `evento`.
 *
 * NAO e cosmetica: uma linha curta cabe num unico `write(2)`, e e a atomicidade
 * desse `write` unico que impede duas linhas de dois processos de se
 * intercalarem (ver `./log.ts`). Um `evento` sem teto poria essa garantia nas
 * maos de quem chama.
 */
export const MAX_EVENTO_LENGTH = 200

/** Marcador acrescentado ao `evento` que foi cortado por {@link MAX_EVENTO_LENGTH}. */
export const TRUNCATED_MARK = '[TRUNCADO]'

/** Valor gravado quando `evento` chega vazio. Registar o facto, nao rebentar. */
export const EVENTO_SEM_NOME = 'evento_sem_nome'

/** Valor gravado em `ip_normalizado` quando o que chegou nao e um endereco. */
export const IP_INVALIDO = 'nao-ip'

/** Um digest hexadecimal plausivel para `sessao_id_hash` (16 a 64 nibbles). */
const HASH_HEX = /^[0-9a-f]{16,64}$/u

/** Conjunto de caracteres que um endereco IP (v4 ou v6) pode ter, e mais nenhum. */
const IP_CHARSET = /^[0-9a-f.:]{1,45}$/iu

/** IPv4 com porta colada (`1.2.3.4:5678`) -- alguns proxies escrevem assim. */
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u

/** Alcance maximo de um `Date` em milissegundos (ECMA-262, +-100 000 000 dias). */
const MAX_EPOCH_MS = 8.64e15

/**
 * As formas que `redact()` NAO cobre, e a razao de cada uma.
 *
 * Cada entrada mascara SO o grupo `$2` e preserva `$1` -- a mesma convencao de
 * `redact.ts`, para que quem leia os dois ficheiros nao tenha de trocar de
 * modelo mental a meio.
 *
 * ORDEM DE APLICACAO: sempre DEPOIS de `redact()`. Todas sao idempotentes sobre
 * o proprio `[REDACTED]` (o `[` nao pertence a nenhuma das classes de
 * caracteres), portanto correr a cadeia duas vezes da o mesmo resultado -- o que
 * e testado, porque um mascarador nao idempotente e um mascarador que come o
 * proprio marcador e volta a expor o resto da linha.
 */
const AUDIT_SHAPES: ReadonlyArray<{ pattern: RegExp; keep: string }> = [
  {
    /*
     * Token do bot do Telegram, PRECEDIDO DO PREFIXO `bot` -- que e a forma
     * exata com que ele viaja no CAMINHO do URL da Bot API
     * (`https://api.telegram.org/bot<id>:<segredo>/sendMessage`). E por isso que
     * ele vaza em log de HTTP, em log de proxy e em APM sem ninguem o ter
     * registado: nao e um campo, e parte do endereco.
     *
     * DIFERENCA PARA `redact.ts`, e a razao de esta entrada existir: a forma de
     * la exige `[A-Za-z0-9_-]{20,}` depois dos dois pontos, limite escolhido
     * para nao mascarar meio log por causa de qualquer `12345:abc`. Um token
     * TRUNCADO por outra camada (uma mensagem de erro que corta o URL, um id de
     * teste) fica abaixo desse limite e sobrevive. Aqui o prefixo literal `bot`
     * ja torna o padrao especifico o suficiente para nao precisar do minimo, e
     * este ficheiro escreve um log de AUDITORIA -- o sitio onde um falso
     * positivo custa uma linha ilegivel e um falso negativo custa o bot.
     */
    // O lookahead impede a corrida de `[\w-]` de ENGOLIR um segundo `bot<id>:`
    // colado ao primeiro -- sem ele, `bot1:AAAbot2:BBB` mascarava `AAAbot2` e
    // deixava `BBB` em claro. Achado do teste de propriedade, nao da leitura.
    pattern: /(bot\d+:)((?:(?!bot\d+:)[\w-])+)/gu,
    keep: '$1',
  },
  {
    /*
     * CAUDA DE UM SEGREDO ENGOLIDO PELA CAMADA 1. `redact()` casa `\d{6,12}:`
     * com `[A-Za-z0-9_-]{20,}` GULOSO: em `bot<id>:<s1>bot<id>:<s2>` colados sem
     * separador ele consome `<s1>bot<id>` e deixa `:<s2>` de fora -- ja sem
     * prefixo `bot` para as formas acima ancorarem. Achado pelo teste de
     * propriedade, nao pela leitura.
     *
     * O que sobra tem assinatura inconfundivel: o marcador de redaccao, dois
     * pontos, e uma corrida longa de caracteres de token. Isso so acontece
     * DEPOIS de um corte, portanto nao ha falso positivo a temer -- e a unica
     * forma de o texto conter `[REDACTED]:` e ter passado por aqui.
     *
     * O literal tem de acompanhar {@link REDACTED}; o teste de format.ts tem um
     * fio de alarme para o dia em que alguem mudar o marcador.
     */
    pattern: /(\[REDACTED\]:)([\w-]{16,})/gu,
    keep: '$1',
  },
  {
    /*
     * URL do tunel efemero do `cloudflared`. O URL NAO e um endereco publico
     * qualquer: e a propria capacidade -- quem o tem, alcanca a barreira. Por
     * isso ele nunca e persistido (03-ONDAS.md 7) e nunca e registado.
     *
     * Cobre a forma `quick` (`*.trycloudflare.com`), que e a unica cujo dominio
     * e conhecido a priori. Um tunel `named` usa o dominio do proprio dono, que
     * nenhuma forma consegue adivinhar: esse depende da camada 1 (o URL entra em
     * `knownSecrets`), e e por isso que `openAuditLog` recebe um FORNECEDOR de
     * segredos e nao uma lista fixa -- o URL muda a cada arranque.
     */
    // SEM ancora de fronteira. Tinha um `(\b)` a abrir, que capturava a string
    // vazia e nao servia para nada exceto FALHAR: em `url1https://x.trycloudflare.com`
    // nao ha fronteira de palavra entre `1` e `h`, e o URL sobrevivia inteiro.
    // Um `https://` ja e auto-delimitado -- nao precisa de ancora nenhuma.
    pattern: /https?:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com[^\s"']*/giu,
    keep: '',
  },
  {
    /*
     * `mk` do link magico: 128 bits, TTL 120 s, uso unico (T2.2). Curto e
     * descartavel, mas dentro da janela e uma sessao autenticada inteira -- e um
     * log e exatamente o sitio onde um valor de 120 segundos sobrevive anos.
     *
     * O lookbehind evita casar o sufixo de outra chave (`webhook_mk=`). Cobre
     * `?mk=`, `&mk=` e `#mk=` (o link magico pode levar o segredo no FRAGMENTO,
     * que e a variante que nem chega ao servidor).
     */
    pattern: /((?<![\w-])mk=)([^&\s"']+)/giu,
    keep: '$1',
  },
  {
    /*
     * O segredo do plugin na sua forma de APRESENTACAO: base32 RFC 4648
     * (`A-Z2-7`), 256 bits => 52 caracteres, opcionalmente agrupado com hifens
     * para ser ditavel ao telefone.
     *
     * PORQUE UMA FORMA E NAO SO O LITERAL: T2.1 descarta o segredo em claro da
     * memoria assim que o mostra uma vez. Um sink de auditoria que dependesse de
     * receber o literal para o mascarar so o mascararia enquanto ele existisse
     * -- ou seja, nunca, porque o unico momento em que ele existe e o momento em
     * que ninguem o esta a registar. A forma e a camada que funciona depois
     * disso, e e por isso que ela e mais importante aqui do que em `redact.ts`.
     *
     * O piso de 40 caracteres (contra os 52 reais) da margem para uma variante
     * de 192 bits sem descer ao ponto em que uma palavra em maiusculas casa.
     */
    // AS FRONTEIRAS EXCLUEM SO `[A-Z2-7]`, NAO O HIFEN. Excluir o hifen fazia o
    // match falhar POR COMPLETO quando havia um hifen colado (`-MZXW…` ou
    // `…QGE-`) -- e a forma agrupada que este mesmo comentario documenta e feita
    // de hifens, portanto a guarda anulava o caso que mais interessava.
    // A alternativa AGRUPADA vem primeiro: a alternancia e leftmost-first, e sem
    // isso o ramo contiguo mordia so o primeiro grupo.
    pattern: /(?<![A-Z2-7])(?:[A-Z2-7]{4,8}(?:-[A-Z2-7]{4,8}){4,}|[A-Z2-7]{40,})(?![A-Z2-7])/gu,
    keep: '',
  },
]

/**
 * Mascara `text` com as duas camadas: `redact()` primeiro, {@link AUDIT_SHAPES}
 * depois.
 *
 * @param text texto a escrever num campo do registo.
 * @param knownSecrets literais que o chamador SABE serem segredos (URL do tunel
 *   `named`, token do bot vindo da configuracao). Camada 1: exata, nao depende
 *   de o segredo ter o formato esperado.
 */
export function maskAuditText(text: string, knownSecrets: readonly string[] = []): string {
  let result = redact(text, knownSecrets)

  for (const { pattern, keep } of AUDIT_SHAPES) {
    // Copia da regex: `lastIndex` de uma regex global e estado partilhado entre
    // chamadas. `replace` reinicia-o, mas a copia torna a funcao reentrante --
    // e este ficheiro e chamado de dois sitios por registo.
    result = result.replace(new RegExp(pattern.source, pattern.flags), `${keep}${REDACTED}`)
  }

  return result
}

/**
 * Normaliza o IP de origem para uma forma unica e comparavel.
 *
 * PORQUE NORMALIZAR: `::ffff:127.0.0.1` e `127.0.0.1` sao o mesmo host e
 * aparecem os dois, consoante o socket seja v6 com mapeamento v4 ou v4 puro. Um
 * log com as duas formas nao se consegue agregar, e um limitador que contasse
 * por esta string contaria o mesmo atacante duas vezes.
 *
 * PORQUE O LIXO NAO E REGISTADO EM CLARO: depois do spike S2 sabemos que
 * `X-Forwarded-For` e ACRESCENTADO ao valor do cliente, logo o conteudo deste
 * campo pode ser texto arbitrario escolhido por quem ataca. Escrever esse texto
 * no ficheiro nao vaza segredo nenhum (o JSON escapa tudo), mas suja um campo
 * que os leitores tratam como endereco. Fica {@link IP_INVALIDO}, que e um facto
 * verdadeiro; o valor cru pertence a um evento proprio do vocabulario de T5.4.
 */
export function normalizeIp(raw: string | undefined): string | null {
  if (raw === undefined) return null

  let value = raw.trim()
  if (value.length === 0) return null

  // `[::1]:8080` / `[::1]` -- forma de autoridade de URL.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(value)
  if (bracketed?.[1] !== undefined) value = bracketed[1]

  const withPort = IPV4_WITH_PORT.exec(value)
  if (withPort?.[1] !== undefined) value = withPort[1]

  // Zona de scope de IPv6 (`fe80::1%eth0`): identifica a interface, nao o host.
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  value = value.toLowerCase()

  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice('::ffff:'.length)

  if (value.length === 0) return null
  return IP_CHARSET.test(value) ? value : IP_INVALIDO
}

/**
 * `sha256` hexadecimal de um id de sessao, para o campo `sessao_id_hash`.
 *
 * PORQUE ISTO EXISTE AQUI e nao em cada chamador: correlacionar duas linhas do
 * log exige que a mesma sessao de sempre o mesmo valor. Dois chamadores com dois
 * hashes diferentes (um com `sha256`, outro com os primeiros 8 caracteres do id)
 * produzem um log que parece correlacionavel e nao e.
 *
 * PORQUE HASHEAR A SESSAO E LEGITIMO, e hashear o SEGREDO nao (a pergunta 4
 * desta sub-tarefa): um id de sessao e 128 bits de CSPRNG com validade de horas
 * -- o digest nao e adivinhavel e o preimage nao vale nada depois de expirar. O
 * segredo do plugin e a credencial permanente do dono: gravar `sha256(tentativa)`
 * daria a quem lesse o ficheiro um oraculo OFFLINE para testar palpites sem
 * tocar no gate, sem passar pelo limitador e sem deixar rasto. Por isso nao ha,
 * em lado nenhum deste modulo, uma funcao que aceite um segredo.
 */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/** Aplica a lista branca e o mascaramento. Nao serializa. */
export function toAuditRecord(
  event: AuditEvent,
  tsMs: number,
  knownSecrets: readonly string[] = [],
): AuditRecord {
  // Lido como `string` DE PROPOSITO: o tipo do contrato nao existe em runtime, e
  // esta guarda existe exatamente para o chamador que nao o respeita -- um
  // objeto vindo de `JSON.parse`, de codigo JS, ou de um `as` mal posto.
  const resultado: string = event.resultado
  if (resultado !== 'permitido' && resultado !== 'negado') {
    /*
     * PORQUE ISTO REBENTA E O `evento` VAZIO NAO: `resultado` tem dois valores,
     * e escrever o valor errado INVERTE o significado do registo -- uma prova
     * que diz o contrario do que aconteceu e pior do que prova nenhuma. Um nome
     * de evento em falta nao inverte nada: perde-se detalhe, e o detalhe perdido
     * fica registado como tal.
     */
    throw new AuditFormatError(
      `resultado invalido: ${JSON.stringify(resultado)} (esperado 'permitido' ou 'negado')`,
    )
  }

  /*
   * `Number.isFinite` nao chega: `new Date(1e20).toISOString()` LANCA um
   * `RangeError`, e um `RangeError` a subir de dentro do sink de auditoria seria
   * indistinguivel de uma falha de escrita -- ou seja, fecharia o gate por um
   * defeito de formatacao. `8.64e15` e o alcance maximo de um `Date`.
   */
  if (!Number.isFinite(tsMs) || Math.abs(tsMs) > MAX_EPOCH_MS) {
    throw new AuditFormatError(`ts invalido: ${String(tsMs)} (esperado epoch em milissegundos)`)
  }

  return {
    ts: new Date(tsMs).toISOString(),
    evento: maskEvento(event.evento, knownSecrets),
    resultado: event.resultado,
    ip_normalizado: normalizeIp(event.ip_normalizado),
    /*
     * O campo chama-se `_hash` e e isso que aceita. Se o que chegou nao tem a
     * forma de um digest, o chamador passou o id CRU -- que e exatamente o
     * acidente que a marca de tipo `SessionId` nao consegue apanhar, porque em
     * runtime ela e uma string como qualquer outra. Registar `[REDACTED]` perde
     * a correlacao dessa linha; registar o id cru perdia a sessao.
     */
    sessao_id_hash: acceptHash(event.sessao_id_hash),
  }
}

/** Ver o comentario em {@link toAuditRecord}. */
function acceptHash(hash: string | undefined): string | null {
  if (hash === undefined) return null
  return HASH_HEX.test(hash) ? hash : REDACTED
}

/** Serializa um evento numa linha pronta a escrever, com o `\n` final incluido. */
export function formatAuditLine(
  event: AuditEvent,
  tsMs: number,
  knownSecrets: readonly string[] = [],
): string {
  return `${JSON.stringify(toAuditRecord(event, tsMs, knownSecrets))}\n`
}

/** Mascara e limita o nome do evento. Ver {@link MAX_EVENTO_LENGTH}. */
function maskEvento(raw: string, knownSecrets: readonly string[]): string {
  const masked = maskAuditText(raw, knownSecrets).trim()
  if (masked.length === 0) return EVENTO_SEM_NOME
  if (masked.length <= MAX_EVENTO_LENGTH) return masked
  return `${masked.slice(0, MAX_EVENTO_LENGTH)}${TRUNCATED_MARK}`
}
