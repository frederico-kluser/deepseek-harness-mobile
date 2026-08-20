/**
 * S12 — POSSE DO DESPACHO: mede o que acontece quando duas barreiras se
 * empilham, quando a reversão sai da ordem LIFO, e quando um terceiro toma
 * conta do despacho. Mede também a semântica do Node 24 para um servidor sem
 * listeners de `upgrade`, que é o que justifica a barreira instalar o listener
 * de upgrade condicionalmente.
 *
 * Correr: node scripts/spike/intercept/posse.mjs
 */
import { montarComposicao } from './composicao.mjs'
import { pedir } from './http-lab.mjs'

const linha = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

// ─────────────────────────────────────────────────────────────────────────────
linha('M1 — empilhar duas barreiras e revertê-las fora de ordem LIFO')
{
  const { instalarBarreira, BarreiraIndisponivel, MARCA_DE_POSSE } = await import('./barreira.mjs')

  console.log('  M1.a — o PERIGO, reproduzido com a versao ingenua (sem marca de posse):')
  {
    /** Versao ingenua: exactamente o que a barreira fazia antes do endurecimento. */
    const ingenua = (svc, autoriza) => {
      const server = svc.server
      const originais = server.listeners('request')
      const meu = (req, res) => {
        if (!autoriza(req)) { res.writeHead(401); res.end('guarda'); return }
        for (const l of originais) l.call(server, req, res)
      }
      server.removeAllListeners('request')
      server.on('request', meu)
      return () => {
        server.removeListener('request', meu)
        for (const l of originais) server.on('request', l)
      }
    }
    const lab = await montarComposicao()
    const server = lab.webServer.server
    const a = ingenua(lab.webServer, () => false)
    const b = ingenua(lab.webServer, () => false)
    console.log(`    apos instalar A e B: listenerCount(request)=${server.listenerCount('request')}`)
    a()   // reversao FORA de ordem LIFO
    console.log(`    apos a() (nao-LIFO):  listenerCount(request)=${server.listenerCount('request')} <- despacho DUPLICADO`)
    b()
    console.log(`    apos b():             listenerCount(request)=${server.listenerCount('request')}`)
    // A dupla resposta ao mesmo `res` levanta um erro NAO capturavel pelo cliente:
    // o segundo despacho tenta escrever cabecalhos ja enviados.
    const capturados = []
    const apanhar = (err) => capturados.push(err.code ?? err.message)
    process.on('uncaughtException', apanhar)
    const r = await pedir(lab.port, '/api/state')
    await new Promise((res) => setImmediate(res))
    process.off('uncaughtException', apanhar)
    console.log(`    GET /api/state -> ${r.status} ${r.status === 200 ? '(BARREIRA DESAPARECEU)' : ''}`)
    console.log(`    excecoes nao capturadas no processo: ${JSON.stringify(capturados)} <- dupla escrita no mesmo res`)
    await lab.dispose()
  }

  console.log('  M1.b — a versao endurecida RECUSA o empilhamento na instalacao:')
  {
    const lab = await montarComposicao()
    const server = lab.webServer.server
    const reverter = instalarBarreira(lab.webServer, { authorize: () => false })
    console.log(`    marca de posse no listener instalado? ${server.listeners('request')[0][MARCA_DE_POSSE] === true}`)
    try {
      instalarBarreira(lab.webServer, { authorize: () => false })
      console.log('    segunda instalacao NAO lancou (inesperado)')
    } catch (err) {
      console.log(`    ${err instanceof BarreiraIndisponivel ? 'BarreiraIndisponivel' : err.name}: ${err.message.split('.')[0]}.`)
    }
    console.log(`    listenerCount(request)=${server.listenerCount('request')} (inalterado)`)
    reverter()
    console.log(`    apos reversao: listenerCount(request)=${server.listenerCount('request')}, GET /api/state -> ${(await pedir(lab.port, '/api/state')).status}`)
    await lab.dispose()
  }

  console.log('  M1.c — perda de posse por terceiro: a reversao NAO restaura por cima, falha alto:')
  {
    const lab = await montarComposicao()
    const server = lab.webServer.server
    const reverter = instalarBarreira(lab.webServer, { authorize: () => false })
    // Um terceiro toma conta do despacho, ignorando a nossa marca.
    server.removeAllListeners('request')
    server.on('request', (req, res) => { res.writeHead(418); res.end('terceiro') })
    try {
      reverter()
      console.log('    reversao NAO lancou (inesperado)')
    } catch (err) {
      console.log(`    ${err.name}: ${err.message.split('(')[0].trim()}`)
    }
    console.log(`    listenerCount(request)=${server.listenerCount('request')} (so o terceiro; sem duplicacao)`)
    console.log(`    GET /api/state -> ${(await pedir(lab.port, '/api/state')).status} (o terceiro responde, nada duplicado)`)
    await lab.dispose()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
linha('M2 — Node 24: servidor com ZERO listeners de `upgrade` NAO fecha a ligacao')
{
  const { createServer } = await import('node:http')
  const { pedirUpgrade } = await import('./http-lab.mjs')
  const s = createServer((req, res) => { res.writeHead(200); res.end('via caminho request') })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  console.log(`  listenerCount('upgrade') = ${s.listenerCount('upgrade')}`)
  console.log(`  pedido com Connection: Upgrade -> ${JSON.stringify(await pedirUpgrade(p, '/x'))}`)
  // Sockets promovidos deixam de ser contabilizados pelo servidor: guardamos a
  // referencia para os poder destruir e deixar o `close()` resolver.
  const promovidos = []
  s.on('upgrade', (req, sock) => {
    promovidos.push(sock)
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  console.log(`  com 1 listener de upgrade      -> ${JSON.stringify(await pedirUpgrade(p, '/x'))}`)
  s.closeAllConnections()
  for (const sock of promovidos) sock.destroy()
  await new Promise((r) => s.close(r))
  console.log('  => por isso a barreira SO instala listener de `upgrade` se ja existia algum:')
  console.log('     sem originais, o trafego de upgrade cai no caminho `request`, que ja esta guardado.')
}
