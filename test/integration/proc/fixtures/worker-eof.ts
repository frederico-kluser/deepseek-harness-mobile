/**
 * WORKER DE MEDICAO do dead-man's switch. Nao e uma suite (`.ts`, sem `.test.`).
 *
 * O QUE ELE PROVA: um processo que nao tem qualquer outra razao para morrer
 * — nenhum temporizador que expire, nenhum trabalho que acabe — termina
 * NA MESMA quando o `stdin` chega a EOF, e termina pelo caminho de
 * `worker/ipc.ts` e nao por acidente do runtime.
 *
 * `detached` no lado de quem o cria, para que a morte do pai NAO o leve pelo
 * grupo: assim a unica causa possivel de morte e o EOF que se quer medir.
 *
 * OS MODOS, todos por ambiente, cada um a exercitar UM adversario diferente do
 * dead-man's switch (`DSH_TESTE_MODO`):
 *
 *   (ausente)  o caso base: worker ocioso.
 *   `pause`    alguem chamou `process.stdin.pause()` -- uma linha perfeitamente
 *              normal de se escrever em `worker/telegram-bot.ts`, que ANTES da
 *              defesa desarmava o switch em silencio.
 *   `dispose`  alguem largou o canal e continuou a correr.
 *   `bloqueio` o event loop preso em JavaScript SINCRONO. Nao ha como
 *              interromper isso -- serve para MEDIR o limite honesto da
 *              promessa "< 2 s", nao para o contornar.
 */

import { openSync, writeSync } from 'node:fs'

import { bindWorkerIpcToProcess } from '../../../../worker/ipc.ts'

const modo = process.env['DSH_TESTE_MODO'] ?? ''
const bloqueioMs = Number(process.env['DSH_TESTE_BLOQUEIO_MS'] ?? '400')
const evidencia = process.env['DSH_TESTE_EVIDENCIA'] ?? ''

/**
 * O CODIGO DE SAIDA, NUM FICHEIRO -- e nao em `stderr`.
 *
 * PORQUE UM FICHEIRO: o `stderr` deste processo e um pipe cujo lado de leitura
 * pertence ao host. Morto o host, escrever ali da EPIPE -- ou seja, a evidencia
 * do desligamento desaparece exatamente no cenario que se quer medir.
 *
 * PORQUE E PRECISA: "o processo deixou de existir" NAO distingue "saiu pelo
 * dead-mans switch" de "rebentou com uma excecao por tratar". As duas coisas
 * dao `isAlive() === false`, e um teste que so olhasse para isso ficava verde
 * com o switch desarmado -- foi o que uma mutacao mostrou. `process.exit(0)`
 * do switch da `EXIT=0`; um `'error'` sem ouvinte da `EXIT=1`.
 */
if (evidencia !== '') {
  process.on('exit', (code: number): void => {
    const fd = openSync(evidencia, 'w')
    writeSync(fd, `EXIT=${String(code)}\n`)
  })
}

const ipc = bindWorkerIpcToProcess(process, {
  onMessage: (message): void => {
    ipc.log(`recebi ${message.type}`)
  },
})

if (modo === 'pause') {
  // O adversario silencioso: sem `'data'` a fluir, o `'end'` nunca chega.
  process.stdin.pause()
}

if (modo === 'dispose') {
  // O canal foi largado, mas o PROCESSO continua vivo -- e continua a falar com
  // a internet. O switch tem de sobreviver ao `dispose()`.
  ipc.dispose()
}

ipc.log('pronto')

// Sem isto o processo sairia por falta de trabalho e a medicao seria uma
// mentira: o que se quer e um processo que SO o EOF consegue matar. E por isso
// que este temporizador NAO leva `unref()` -- ele existe precisamente para
// segurar o event loop.
setInterval((): void => {}, 3600_000)

if (modo === 'bloqueio') {
  /**
   * `writeSync(2, ...)` e NAO `process.stderr.write`, e a diferenca e o teste
   * inteiro: `process.stderr` ligado a um pipe e ASSINCRONO -- os bytes so
   * saem quando o event loop volta, e aqui o event loop nunca mais volta. Com a
   * escrita sincrona, quem mede ve a marca com o bloqueio JA a correr, e o
   * `SIGKILL` cai mesmo dentro dele em vez de cair por sorte.
   */
  writeSync(2, 'BLOQUEIO\n')
  const fim = Date.now() + bloqueioMs
  while (Date.now() < fim) {
    // Ocupacao deliberada do event loop. Nenhum `'end'` e entregue aqui dentro,
    // e NAO EXISTE forma de o entregar: e JavaScript sincrono. E este o limite
    // honesto da promessa "< 2 s".
  }
}
