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
 * chaves proprias deste plugin (`allowedHosts`, `trustedRemotes`,
 * `guardedPrefixes`, `deniedPermissions`, `worker`): qualquer uma em falta lanca
 * aqui, com o nome da chave na mensagem.
 *
 * NOTA sobre a semantica do `replace` (corrigida): e SHALLOW MERGE das chaves de
 * topo da entrada (`lib/index.js:100-103`), nao *whole-entry replace*. So o
 * objeto `config`, quando fornecido, e substituido inteiro -- e e por isso que
 * uma chave omitida DENTRO de `config` continua a ser uma chave apagada.
 */
import type { ExposureConfig, TunnelConfig } from '../contracts/tunnel.ts';
import { type AgentsConfig, type Config, type ControlConfig } from './schema.ts';
/**
 * Tecto do TTL do tunel, em minutos. 8 horas.
 *
 * `src/contracts/tunnel.ts` congela a reconciliacao entre D6 ("default 60") e
 * `04-TESTES.md` TUN-019 ("ausente, 0, negativo, nao inteiro ou > 480 recusa no
 * load; NENHUM default silencioso"). Nao ha contradicao:
 *
 *   >>> O DEFAULT DE 60 VIVE NO `cordis.patch.yml`, NAO NO CODIGO. <<<
 *
 * O manifesto entrega `ttlMinutes: 60` como VALOR LITERAL -- um valor que o
 * utilizador ve e edita, logo nao e silencioso. O codigo nao tem fallback
 * nenhum.
 */
export declare const TUNNEL_TTL_MAX_MINUTES = 480;
/**
 * Valida o eixo `exposure`. So corre quando a chave EXISTE -- a ausencia e lida
 * por `resolveExposure` como `LOOPBACK_ONLY_EXPOSURE`, que e a leitura fechada.
 */
export declare function assertExposureConfig(value: unknown, path: string): asserts value is ExposureConfig;
/**
 * Valida o eixo `tunnel`. So corre quando a chave EXISTE.
 *
 * TUN-019 vive aqui, e vive INTEIRO: `ttlMinutes` ausente, `0`, negativo, nao
 * inteiro ou `> 480` recusa no load, com erro accionavel, sem default
 * silencioso e SEM CLAMP. Um `ttlMinutes: 10080` reduzido em silencio a 480 diz
 * ao utilizador que ele pediu uma semana e recebeu uma semana -- e a ameaca T10
 * de `02-SEGURANCA.md` e exatamente essa: abre-se o tunel numa terca a noite,
 * fecha-se o portatil, e descobre-se no domingo que ele nunca fechou.
 */
export declare function assertTunnelConfig(value: unknown, path: string): asserts value is TunnelConfig;
/**
 * Teto de `config.agents.maxRuns` (EMENDA ONDA-4-FIX-REPORT-CAPS).
 *
 * DERIVADO, nao um literal. O relatorio `agent.report` viaja numa UNICA linha
 * do canal IPC e o codec RECUSA listas acima de `MAX_RUNS_PER_REPORT` (64) —
 * `IPC_MESSAGE_INVALID` do lado da escrita: o relatorio nao chega ao worker e
 * as difusoes perdem-se. A tabela do registry chega a `maxRuns` vivos + 32
 * terminais (`MAX_RUNS_HISTORY`), logo o teto de concorrencia e
 * `MAX_RUNS_PER_REPORT - MAX_RUNS_HISTORY` — hoje 64 - 32 = 32: historico
 * cheio + teto cheio e EXATAMENTE a linha do canal. Acima disto a configuracao
 * e recusada no load (fail loud, Q-3), sem clamp.
 */
export declare const AGENTS_MAX_RUNS_CEILING: number;
/** Valida o eixo `control` -- minimo. A expansao e do COMMIT PREP 5. */
export declare function assertControlConfig(value: unknown, path: string): asserts value is ControlConfig;
/**
 * Valida o eixo `agents` (EMENDA ONDA-4-AGENTS-HOST). So corre quando a chave
 * EXISTE — a ausencia e lida por `resolveAgents` como `AGENTS_FAIL_CLOSED`.
 *
 * Fail loud, como tudo aqui (Q-3): `skills` tem de ser um array de nomes
 * kebab-case NAO VAZIOS, e `maxRuns` um inteiro entre 1 e
 * `AGENTS_MAX_RUNS_CEILING` (32 — o relatorio `agent.report` cabe na linha do
 * canal com o historico cheio). Um nome com espacos, maiusculas ou um
 * `maxRuns: 0` (ou negativo, ou acima do teto) sao configuracoes que se
 * revelariam erradas no primeiro despacho — recusadas no load.
 */
export declare function assertAgentsConfig(value: unknown, path: string): asserts value is AgentsConfig;
/** Valida a configuracao INTEIRA no arranque. */
export declare function assertValidConfig(config: Config): void;
//# sourceMappingURL=assert.d.ts.map