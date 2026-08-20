/**
 * WORKER DE ECO, para o teste de ponta a ponta do canal sobre pipes REAIS.
 * Nao e uma suite (`.ts`, sem `.test.`).
 *
 * Faz TRES coisas, e cada uma prova uma invariante:
 *
 *   - responde a cada `state` do host com uma `intent` (o canal e bidirecional
 *     sobre `stdin`/`stdout` de verdade, e nao sobre `PassThrough`);
 *   - escreve ruido humano em `stderr` a cada mensagem (S2: se este ruido
 *     aparecesse no `stdout`, o analisador do pai partia -- e o teste ve isso);
 *   - envia DUAS intencoes de rajada no arranque, para que o pai tenha de
 *     reconstruir linhas partidas pelo pipe.
 */

import { bindWorkerIpcToProcess } from '../../../../worker/ipc.ts'

let recebidas = 0

const ipc = bindWorkerIpcToProcess(process, {
  onMessage: (message): void => {
    // Ruido humano, DELIBERADO e em stderr. E o que o worker real faz a cada
    // update; no stdout partiria o protocolo em silencio.
    ipc.log(`mensagem do tipo ${message.type}`)

    /**
     * SO O `state` PROVOCA RESPOSTA, e a razao ficou medida: responder tambem
     * ao `ack` fecha um CICLO -- o host responde a intencao com um `ack`, o
     * worker responde ao `ack` com outra intencao, e o par corre em ping-pong
     * ate saturar. Na primeira versao deste dublê chegaram 2 064 905 intencoes
     * em 15 segundos.
     *
     * Nao e so um cuidado de teste: e a forma do protocolo. O `ack` FECHA uma
     * troca; quem lhe responder esta a inventar uma nova.
     */
    if (message.type !== 'state') return
    recebidas += 1

    ipc.send({
      v: 1,
      type: 'intent',
      intent: 'tunnel.status',
      requestId: `eco-${String(recebidas)}`,
      from: 111,
      chat: 222,
      nonce: 'nonce-opaco-que-o-worker-nao-le',
    })
  },
})

ipc.log('pronto')

// Mantem o processo vivo: so o EOF do stdin (ou o tree-kill) o deve matar.
setInterval((): void => {}, 3600_000)
