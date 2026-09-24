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
/* ---- identidade neutra -------------------------------------------------- */
export { isValidIdentity, normalizeIdentity, normalizeKey } from "./ids.js";
/* ---- o NUCLEO (roteador neutro + publicacao da lista) ------------------- */
export { COMANDOS_PUBLICADOS, criarNucleo, criarProjecao, extrairNomeDeComando, registarComandosPublicados, runsTerminadosDesde, textoDeRecusa, } from "./core.js";
/* ---- texto de estado (TG-084) ------------------------------------------- */
export { cortarTexto, estreitarEstado, formatarDuracao, formatarHora, formatarQuantidade, formatarTempoDeMs, haQuantoTempo, linhaDeRun, MAX_BASE_CHARS, MAX_PROMPT_CHARS, MAX_TEXTO_MENSAGEM, resumoDeMetricas, ROTULOS_DE_ESTADO, ROTULOS_DE_KIND_DE_RUN, ROTULOS_DE_STATUS_DE_AGENTE, sanearUmaLinha, TETO_DE_RUNS_DO_RELATORIO, tempoDeTrabalhoMs, TEXTO_DE_AJUDA, textoDeEstado, textoDeEstadoCurto, textoDeFimDeRuns, textoDeRelatorioDeAgentes, textoDeTarefa, totalDeTokens, } from "./text.js";
/* ---- accoes de alerta (botoes dos notify) ------------------------------- */
export { botoesDeAlerta, extrairAlerta, TIPOS_DE_ALERTA } from "./actions.js";
/* ---- tokens (requestId ULID + token opaco) ------------------------------ */
export { gerarRequestId, gerarTokenOpaque } from "./tokens.js";
/* ---- autenticacao (allowlist + guard + pareamento) ---------------------- */
export { ALLOWLIST_VAZIA, autorizar, AUMENTA_EXPOSICAO, criarAllowlistSurface, criarAuthDeSuperficie, criarDesafioDePareamento, criarGuardDeIdentidade, criarReceptorDePareamento, decidirAutorizacao, LIMITES_PAREAMENTO_PADRAO, RESPOSTA_AGUARDANDO_CANCELADO, RESPOSTA_AGUARDANDO_EXPIROU, RESPOSTA_BOAS_VINDAS, RESPOSTA_JA_PAREADO, RESPOSTA_PAREAMENTO_RECUSADO, RESPOSTA_PAREAR_VAZIO_JA_PAREADO, RESPOSTA_PEDIR_VALOR, RESPOSTA_PEDIR_VALOR_MALFORMADO, SurfaceAuthError, } from "./auth.js";
/* ---- comandos (o despacho neutro que o nucleo consome) ------------------ */
export { comandoPublicado, criarAccess, criarAgentes, criarComandosDaSuperficie, criarComandosDeSuperficie, criarOnOff, criarStatus, criarTarefas, TTL_CONFIRMACAO_DESPACHO_MS, TTL_TOKEN_DESLIGAR_MS, } from "./commands.js";
/* ---- emissores (particao TG-048 + serializacao TG-049) ------------------ */
export { criarOutbox, INTERVALO_MINIMO_PADRAO_MS, MARCADOR_DE_CORTE, particionarTexto, truncarTexto, } from "./outbox.js";
//# sourceMappingURL=index.js.map