/**
 * `src/proc/tree-kill.ts` -- kill do GRUPO de processos, sem guarda por estado.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { treeKill } from '../../../src/proc/tree-kill.ts'

function recorder(): { kills: Array<[number, string]>; kill: (p: number, s: NodeJS.Signals) => void } {
  const kills: Array<[number, string]> = []
  return {
    kills,
    kill: (pid: number, signal: NodeJS.Signals): void => {
      kills.push([pid, signal])
    },
  }
}

describe('treeKill', () => {
  it('sinaliza o GRUPO (-pid) com SIGKILL', () => {
    const { kills, kill } = recorder()
    treeKill({ pid: 4242 }, { platform: 'linux', kill })
    assert.deepEqual(kills, [[-4242, 'SIGKILL']])
  })

  it('ignora um pid que nao designa grupo nenhum (-1 = o spawn falhou)', () => {
    const { kills, kill } = recorder()
    treeKill({ pid: -1 }, { platform: 'linux', kill })
    treeKill({ pid: 0 }, { platform: 'linux', kill })
    assert.deepEqual(kills, [])
  })

  it('nao invoca process.kill(-pid) no Windows (nao ha grupos POSIX)', () => {
    const { kills, kill } = recorder()
    treeKill({ pid: 999 }, { platform: 'win32', kill })
    assert.deepEqual(kills, [], 'em Windows o tree-kill e taskkill /T /F dentro do ctx.subprocess')
  })

  it('engole ESRCH quando o grupo ja nao existe', () => {
    assert.doesNotThrow(() =>
      treeKill(
        { pid: 1234 },
        {
          platform: 'linux',
          kill: (): void => {
            throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
          },
        },
      ),
    )
  })
})
