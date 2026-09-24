/**
 * Contrato do tunel. CONGELADO no COMMIT PREP 3.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA ate ao COMMIT PREP 4.
 *
 * PORQUE ESTE FICHEIRO EXISTE. A Onda 3 tem quatro sub-tarefas que so nao
 * colidem porque partilham VOCABULARIO em vez de partilharem FICHEIRO:
 *
 *   T3.1 `w3-tunnel-supervisor`      -> supervisiona o processo, corre o probe,
 *                                        arma o TTL, gere o pidfile e o argv
 *   T3.2 `w3-tunnel-descoberta-url`  -> descobre a URL e mede o readiness
 *   T3.3 `w3-gate-integra-sessao`    -> fia o gate e amplia a `Config`
 *   T3.4 `w3-painel-guard-http`      -> mostra estado e URL no painel
 *
 * A ordem de merge e T3.2 -> T3.4 -> T3.1 -> T3.3 (`03-ONDAS.md` 13.1). Repare
 * que T3.3, dona de `src/config/**`, entra por ULTIMO. Se T3.1 importasse os
 * tipos de configuracao de `src/config/schema.ts`, o snapshot de integracao de
 * T3.1 nao compilaria — o ficheiro que os declara ainda nao teria entrado. Por
 * isso as FORMAS de `tunnel.*` e `exposure.*` sao congeladas AQUI e T3.3
 * limita-se a compo-las na `Config` dela. Isto nao e estilo: e o que torna a
 * ordem de merge de 13.1 executavel.
 */
export {};
//# sourceMappingURL=tunnel.js.map