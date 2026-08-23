/**
 * PONTO DE ENTRADA PUBLICO DA SUPERFICIE NEUTRA DE MENSAGERIA.
 *
 * DONO: onda 1 do desacoplamento parler-to-providers. Este ficheiro EH apenas um
 * re-export: NAO define tipos nem funcoes — expoe o CONTRATO e o RESTANTE da
 * superficie (nucleo, autenticacao, comandos, emissores, tokens, texto e accoes)
 * para quem quiser importa-los sem conhecer a disposicao interna de
 * `worker/surface/`.
 *
 * O nucleo neutro (onda 2), os adaptadores de provedor (onda 3) e o boot generico
 * (onda 4) importam A PARTIR DAQUI — ou directamente dos ficheiros internos, tanto
 * faz: este index e o cone publico estavel para futuros provedores. A regra de
 * fronteira e a mesma dos restantes ficheiros do worker: nada de tipos do grammY,
 * nada de `worker/lib/*`; o contrato importa apenas `src/contracts/ipc.ts` (tipos
 * puros). Ver o cabecalho de `./contract.ts`.
 */

/* ---- o CONTRATO (o que QUALQUER provedor implementa) ------------------- */
export type {
  ActionRow,
  ActionRowLayout,
  EmitirNonce,
  IntencaoNeutra,
  ProviderAdapter,
  SurfaceAction,
  SurfaceActionData,
  SurfaceActionEvent,
  SurfaceActionRejectedEvent,
  SurfaceCommandContext,
  SurfaceCommandEvent,
  SurfaceCommandLog,
  SurfaceEditOutcome,
  SurfaceEvent,
  SurfaceIdentity,
  SurfaceIdentityLike,
  SurfaceIpcBridge,
  SurfaceLimits,
  SurfacePendingIntent,
  SurfaceProjectionState,
  SurfacePublishedCommand,
  SurfaceSendOptions,
  SurfaceSender,
  SurfaceSenderFactory,
} from './contract.ts'

/* ---- identidade neutra -------------------------------------------------- */
export { isValidIdentity, normalizeIdentity, normalizeKey } from './ids.ts'

/* ---- o NUCLEO (roteador neutro + publicacao da lista) ------------------- */
export {
  COMANDOS_PUBLICADOS,
  criarNucleo,
  criarProjecao,
  extrairNomeDeComando,
  registarComandosPublicados,
  textoDeRecusa,
  type ComandoPublicado,
  type Nucleo,
  type NucleoDeps,
  type Projecao,
  type SurfaceAdmissao,
  type SurfaceAuth,
  type SurfaceComandos,
  type SurfaceComandosFactory,
  type SurfaceDesafio,
  type SurfaceDono,
  type SurfaceEstadoPareamento,
  type SurfacePareamentoResultado,
} from './core.ts'

/* ---- texto de estado (TG-084) ------------------------------------------- */
export {
  cortarTexto,
  estreitarEstado,
  formatarDuracao,
  formatarHora,
  MAX_TEXTO_MENSAGEM,
  ROTULOS_DE_ESTADO,
  textoDeEstado,
  type EstadoDoTunel,
} from './text.ts'

/* ---- accoes de alerta (botoes dos notify) ------------------------------- */
export { botoesDeAlerta, extrairAlerta, TIPOS_DE_ALERTA, type TipoDeAlerta } from './actions.ts'

/* ---- tokens (requestId ULID + token opaco) ------------------------------ */
export { gerarRequestId, gerarTokenOpaque } from './tokens.ts'

/* ---- autenticacao (allowlist + guard + pareamento) ---------------------- */
export {
  ALLOWLIST_VAZIA,
  autorizar,
  AUMENTA_EXPOSICAO,
  criarAllowlistSurface,
  criarAuthDeSuperficie,
  criarDesafioDePareamento,
  criarGuardDeIdentidade,
  criarReceptorDePareamento,
  decidirAutorizacao,
  LIMITES_PAREAMENTO_PADRAO,
  RESPOSTA_BOAS_VINDAS,
  RESPOSTA_JA_PAREADO,
  RESPOSTA_PAREAMENTO_RECUSADO,
  SurfaceAuthError,
  type SurfaceAllowlist,
  type SurfaceAuthorization,
  type SurfaceDenyReason,
  type SurfaceGuardDecision,
  type SurfaceIdentityGuard,
  type SurfacePairingOutcome,
  type SurfacePairingReceiver,
} from './auth.ts'

/* ---- comandos (o despacho neutro que o nucleo consome) ------------------ */
export {
  comandoPublicado,
  criarAccess,
  criarComandosDaSuperficie,
  criarComandosDeSuperficie,
  criarOnOff,
  criarStatus,
  TTL_TOKEN_DESLIGAR_MS,
  type ComandosAccess,
  type ComandosDaSuperficie,
  type ComandosOnOff,
  type ComandosStatus,
  type SurfaceComandosPlano,
} from './commands.ts'

/* ---- emissores (particao TG-048 + serializacao TG-049) ------------------ */
export {
  criarOutbox,
  INTERVALO_MINIMO_PADRAO_MS,
  MARCADOR_DE_CORTE,
  particionarTexto,
  truncarTexto,
  type SendText,
  type SurfaceOutbox,
  type SurfaceOutboxOptions,
} from './outbox.ts'