// examples/minimal/config.mjs — Config mínima para a demo, espelhando os defaults
// do manifesto de Bundle real (realm, allowedHosts, trustedRemotes, guardedPrefixes,
// worker sem CWD fixo). NÃO usamos 'encodedAuthString' estúpido: a credencial do dono
// é provisionada como digest no estado, como o produto faz com a senha gerada.
import { tmpdir } from 'node:os'

export function makeConfig(overrides = {}) {
  const base = {
    realm: 'Secure DSH Interface',
    allowedHosts: ['127.0.0.1', '::1'],
    trustedRemotes: ['127.0.0.1'],
    guardedPrefixes: ['/api'],
    deniedPermissions: ['danger-full-access'],
    worker: {
      command: process.execPath,
      args: [],
      cwd: tmpdir(),
      token: '',
      graceMs: 3000,
      backoff: { initialDelayMs: 500, maxDelayMs: 10000, maxAttempts: 10, resetAfterMs: 60000 },
    },
  }
  return Object.assign(base, overrides);
}
