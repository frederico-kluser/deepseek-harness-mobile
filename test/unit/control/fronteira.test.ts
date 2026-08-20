/**
 * CTL-030: a fronteira do supervisor de tunel.
 *
 * O controlador e o UNICO dono do estado (docs/control-machine.md): Telegram,
 * painel e UI nativa sao SUPERFICIES e nenhuma chama o supervisor de tunel
 * directamente. Este teste prova-o por `git grep`: em `src/`, o supervisor de
 * T3.1 (`src/tunnel/supervisor.ts`) so pode ser importado por
 *
 *   - `src/control/controller.ts` — o controlador, que o chama;
 *   - `src/index.ts` — a RAIZ DE COMPOSICAO, que o INSTANCIA e o entrega ao
 *     controlador (a costura de T5.1; sem ela o supervisor nao nasceria).
 *
 * Qualquer outro importador em `src/` e uma superficie a contornar o
 * controlador, e o teste falha.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'

describe('CTL-030: so o controlador (e a raiz de composicao) importam o supervisor', () => {
  it('git grep nao encontra um segundo importador em src/', () => {
    const saida = execFileSync('git', ['grep', '-l', 'from .*tunnel/supervisor.ts', '--', 'src/'], {
      encoding: 'utf8',
      cwd: new URL('../../..', import.meta.url).pathname,
    })
    const importadores = saida.split('\n').filter((linha) => linha.length > 0).sort()

    assert.deepEqual(importadores, ['src/control/controller.ts', 'src/index.ts'])
  })
})
