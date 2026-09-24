/**
 * `buildWorkerEnv` -- o ambiente MINIMO que o worker recebe.
 *
 * PORQUE UMA ALLOWLIST E NAO `{ ...process.env }`: o plano de controlo do DSH
 * corre com `ADMIN_USER`/`ADMIN_PASS` no ambiente (e o `cordis.patch.yml` que as
 * le para montar a credencial de Basic Auth). Herdar `process.env` inteiro
 * entregava essas duas variaveis a um binario Python de terceiros que consome
 * input arbitrario da Internet (long-polling do Telegram). Comprometido o bot, o
 * atacante le `ADMIN_PASS` do seu proprio `/proc/self/environ` e autentica-se no
 * plano de controlo -- exatamente o pivo remoto->local que este plugin existe
 * para impedir. O ambiente e portanto CONSTRUIDO, nunca herdado.
 *
 * NOTA SOBRE O ASSENTO: o pacote `dsh-subprocess` ja limpa nomes com forma
 * de credencial e todos os `DSH_*` do ambiente-pai (`scrubbedParentEnv`), e o
 * `env` do spec e mesclado DEPOIS dessa limpeza. Isso e uma segunda camada, nao
 * a nossa: a heuristica dele nao conhece `ADMIN_PASS`, e o `env` explicito que
 * lhe entregamos e precisamente o vector por onde uma entrada deliberada
 * SOBREVIVE a limpeza. A allowlist continua a ser a defesa, nao o assento.
 *
 * O criterio de inclusao e "sem isto um processo Python nao arranca ou nao fala
 * TLS", nao "e comodo ter". Quem precisar de mais (um proxy corporativo, por
 * exemplo) acrescenta aqui explicitamente -- de novo, "explicit > implicit".
 */
/**
 * Marca "este processo foi arrancado pelo plugin, com o canal IPC armado".
 *
 * PARA QUE SERVE, e para que NAO serve. Nao e credencial, nao autoriza nada e o
 * dead-man's switch nao depende dela: o EOF do `stdin` termina o worker haja ou
 * nao marca. O que ela compra e uma MENSAGEM: corrido a mao, o worker tem `fd 0`
 * num terminal ou em `/dev/null`, e no segundo caso via EOF imediato e saia sem
 * dizer porque — indistinguivel de uma avaria. Com a marca ausente ele escreve
 * uma linha em `stderr` a explicar.
 *
 * VALOR DUPLICADO EM `worker/ipc.ts` (`WORKER_IPC_ENV_VAR`) e nao importado: o
 * worker so pode importar `src/contracts/ipc.ts` de `src/`
 * (`05-QUALIDADE-CODIGO.md` 5.5). `test/unit/proc/env.test.ts` assere que as
 * duas constantes sao iguais, para que a divergencia seja um teste vermelho e
 * nao uma mensagem que desaparece.
 *
 * SOBREVIVE AO `scrubbedParentEnv()` do assento — que remove todos os `DSH_*`
 * HERDADOS — porque o `env` explicito do spec e mesclado DEPOIS da limpeza.
 */
export declare const WORKER_IPC_ENV_MARK = "DSH_GUARD_IPC";
/**
 * Identificador do provedor de mensageria ATIVO (desacoplamento do bot, D1).
 *
 * FECHADO e paralelo ao enum de `Config.worker.provider` (o `PersistedState`
 * vive no contrato congelado e ainda so admite `telegram` — a ausencia le-se
 * como o default fechado). Hoje `telegram` e a UNICA entrada registrada neste
 * host e no registry do worker; um provedor futuro ACRESCENTA um literal AQUI
 * e a sua linha em {@link PROVIDER_ENV} — nunca reescreve uma variavel
 * existente, para que nenhuma mudanca mude silenciosamente o token de um bot
 * ja emparelhado.
 */
export type ProviderId = 'telegram';
/** O default fechado do provedor (D1): ausente em config/estado = telegram. */
export declare const DEFAULT_PROVIDER: ProviderId;
/**
 * Tabela provedor -> variavel de ambiente (e demais) que o worker desse
 * provedor espera receber (`TOKEN_ENV_VAR` do lado do worker).
 *
 * Um provedor e apenas uma ENTRADA aqui: o nome do `tokenVar` para onde o
 * `worker.token` vai parar. Telegram usa `TELEGRAM_BOT_TOKEN`; um provedor
 * futuro (ex.: `whatsapp`) acrescentaria a propria linha com o seu `tokenVar`.
 * O nome da variavel esta DUPLICADO do lado do worker
 * (`worker/providers/telegram/token.ts`, `TOKEN_ENV_VAR`) e nao importado por
 * construcao — o worker so pode importar
 * `src/contracts/ipc.ts` de `src/` (`05-QUALIDADE-CODIGO.md` 5.5); a paridade
 * e um teste, nao um import.
 */
export declare const PROVIDER_ENV: Readonly<Record<ProviderId, {
    readonly tokenVar: string;
}>>;
/**
 * Variavel que nomeia o PROVEDOR ATIVO no ambiente do worker.
 *
 * O worker le-a para saber sob que contrato de provider esta a correr, sem ter
 * de adivinhar pelo nome do `tokenVar` (que muda com o provedor). E injetada
 * PELO HOST em `buildWorkerEnv` — por isso e da familia `DSH_*` que o assento
 * raspa do ambiente HERDADO: nunca entra vinda do pai, so e reconstruida na
 * allowlist explicita. Manter o protocolo MODESTO: o worker nao autoriza nada
 * com esta variavel; e so rotulo.
 */
export declare const WORKER_PROVIDER_ENV_VAR = "DSH_GUARD_PROVIDER";
/**
 * Monta o ambiente do worker: allowlist + o token do provedor ativo + a marca
 * do canal IPC + o rotulo do provedor.
 *
 * O token entra por ambiente e NUNCA por argv, porque `argv` e legivel por
 * qualquer processo local em `/proc/<pid>/cmdline`.
 *
 * O `provider` e OPCIONAL com default fechado `telegram` (D1): quem chama sem
 * provider e quem corre hoje, e o alvo da variavel e o MESMO —
 * `TELEGRAM_BOT_TOKEN`. O token vai para `PROVIDER_ENV[provider].tokenVar`
 * (o `tokenVar` proprio de cada provedor); a
 * assinatura faz um provedor futuro mudar apenas o `tokenVar` de destino,
 * nunca o parametro `token`.
 *
 * As chaves sao comparadas em maiusculas porque o Windows trata os nomes de
 * variaveis de forma insensivel a caixa (`SystemRoot` == `SYSTEMROOT`).
 */
/**
 * Resolve o PROVEDOR ATIVO a partir do ambiente (fail-closed, D1).
 *
 * Le `DSH_GUARD_PROVIDER` — a MESMA variavel que rotula o worker. O host a
 * injeta no filho via `buildWorkerEnv`; o CLI de onboarding (`dsh-guard-setup`)
 * le-a para saber com que provedor esta a falar (chave do `secrets.env`,
 * rotulos do texto, sonda). Ausente/vazio = default fechado `telegram`.
 *
 * VALOR DESCONHECIDO = ERRO, nao default. Degradar em silencio para o
 * telegram quando alguem pediu OUTRO provedor leria a CHAVE ERRADA do
 * `secrets.env`
 * e mostraria os rotulos errados — a mesma razao do `resolverProvedor`
 * fail-closed do registry do worker (`worker/providers/registry.ts`).
 */
export declare function resolverProvedorDoAmbiente(ambiente?: Readonly<Record<string, string | undefined>>): ProviderId;
export declare function buildWorkerEnv(source: NodeJS.ProcessEnv, token: string, provider?: ProviderId): NodeJS.ProcessEnv;
//# sourceMappingURL=env.d.ts.map