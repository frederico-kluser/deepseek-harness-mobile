/**
 * =============================================================================
 * EMENDA 2 DA COSTURA, PONTA A PONTA: o supervisor publica, o PERIMETRO obedece.
 * =============================================================================
 *
 * A pergunta falsificavel: *"com o tunel em `READY`, um pedido cujo `Host` e o
 * nome publico do tunel passa o perimetro do gate? E depois de o tunel cair,
 * o MESMO pedido e recusado?"*
 *
 * PORQUE ISTO NAO E O TESTE UNITARIO DA MESMA COISA. O unitario
 * (`test/unit/tunnel/supervisor.test.ts`) prova que o supervisor CHAMA
 * `publish`. Este prova que a chamada CHEGA ao unico sitio onde importa: a
 * allowlist de `Host` de L2.5, construida em `src/http/gate.ts` a partir de
 * `tunnelOrigin.current()`. Sao dois modulos que so a raiz de composicao
 * juntava, e nesta arvore nunca ninguem os tinha juntado -- e por isso que a
 * emenda existia.
 *
 * OS TRES CODIGOS SAO O INSTRUMENTO DE MEDIDA, e cada um diz uma coisa:
 *   403  recusado no PERIMETRO (L2/L2.5) -- o `Host` nao consta da allowlist;
 *   401  passou o perimetro e caiu em L3 -- falta credencial;
 *   200  passou tudo e o despacho original foi alcancado.
 *
 * >>> NENHUM `cloudflared` E INVOCADO (D10). <<< O executavel e o dublê
 * congelado de `test/bin/fake-cloudflared.mjs` e a origem e um servidor que o
 * proprio harness abriu numa porta EFEMERA.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { GateDeps } from '../../../src/http/gate.ts'
import { createGuardedHandler } from '../../../src/http/gate.ts'
import { UNAUTHENTICATED_PANEL_PREFIXES } from '../../../src/index.ts'
import { FakeResponse } from '../../support/ctx-double.ts'
import { bancada, basic, pedido, OWNER_SECRET, type Bancada } from '../../unit/http/bancada.ts'
import { makeTunnelHarness, waitFor, type TunnelHarness } from '../proc/seat.ts'

const limpezas: Array<() => void> = []
after(() => {
  for (const limpeza of limpezas) limpeza()
})

/** Hostname (sem esquema) de uma origem `https://...`. */
function hostnameDe(url: string): string {
  return new URL(url).host
}

describe('a origem do tunel entra na allowlist de `Host` em READY, e sai quando ele cai', () => {
  it('403 -> 401/200 -> 403, com o MESMO pedido e o mesmo `Host`', async () => {
    const h: TunnelHarness = await makeTunnelHarness()
    limpezas.push(() => h.dispose())

    const b: Bancada = bancada({
      comSegredo: true,
      unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
    })
    limpezas.push(() => b.cleanup())

    /**
     * A COSTURA SOB TESTE, e ela e uma linha: o registo que o SUPERVISOR escreve
     * e o registo que o GATE le. E o que a raiz de composicao tem de fazer.
     */
    const gate: GateDeps = { ...b.gate, tunnelOrigin: h.tunnelOrigin }

    let alcancouODespacho = 0
    const handler = createGuardedHandler(
      gate,
      (_req, res): void => {
        alcancouODespacho += 1
        res.writeHead(200)
        res.end()
      },
      'costura:request',
    )

    const responder = async (host: string, credencial?: string): Promise<number> => {
      const res = new FakeResponse()
      const headers: Record<string, string> = { host }
      if (credencial !== undefined) headers['authorization'] = credencial
      await handler(pedido({ method: 'POST', url: '/api/state', headers }), res.asServerResponse())
      return res.statusCode ?? 0
    }

    /* ---- (1) ANTES: ninguem publicou nada ------------------------------- */
    assert.equal(h.tunnelOrigin.current(), undefined)

    /* ---- (2) O TUNEL SOBE DE VERDADE ------------------------------------ */
    const inicial = await h.supervisor.start()
    assert.equal(inicial.state, 'STARTING')
    const pronto = await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
    assert.equal(pronto, true, JSON.stringify(h.supervisor.snapshot()))

    const url = h.supervisor.snapshot().info?.url ?? ''
    assert.equal(url.includes('trycloudflare.com'), true, 'o dublê tem de dar um nome plausivel')
    assert.equal(h.tunnelOrigin.current(), url, 'READY tem de PUBLICAR a origem')
    const hostDoTunel = hostnameDe(url)

    // Sem a publicacao isto era 403: o produto NAO FUNCIONAVA pelo tunel.
    assert.equal(await responder(hostDoTunel), 401, 'passou o perimetro e caiu em L3')
    assert.equal(
      await responder(hostDoTunel, basic(OWNER_SECRET)),
      200,
      'com credencial, o despacho original e alcancado',
    )
    assert.equal(alcancouODespacho, 1)

    /* ---- (3) O TUNEL CAI ------------------------------------------------- */
    h.supervisor.stop()
    assert.equal(h.tunnelOrigin.current(), undefined, 'sair de READY tem de RETIRAR a origem')

    // >>> O CASO-CONTROLO. <<< Um nome `*.trycloudflare.com` derrubado volta a
    // ser distribuido a outra pessoa: uma entrada morta na allowlist e um
    // bypass, e nao apenas arrumacao por fazer.
    assert.equal(
      await responder(hostDoTunel, basic(OWNER_SECRET)),
      403,
      'o hostname antigo NAO pode continuar a passar L2.5',
    )
    assert.equal(alcancouODespacho, 1, 'nada mais chegou ao despacho original')
  })
})
