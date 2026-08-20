// Framing WebSocket minimo (RFC 6455) em Node puro, sem dependencia nova.
// Cobre so o que o spike S3 precisa: frames text/close/ping/pong pequenos,
// unmasking de frames do cliente e emissao de frames nao mascarados do servidor.

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
})

/** Limite defensivo: um frame maior que isto aborta a conexao no spike. */
const MAX_PAYLOAD = 1_000_000

/** Parser incremental: recebe chunks TCP e devolve frames completos. */
export class FrameParser {
  #buf = Buffer.alloc(0)

  /** @returns {{fin:boolean, opcode:number, payload:Buffer}[]} */
  push(chunk) {
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk])
    const frames = []
    for (;;) {
      const frame = this.#tryRead()
      if (frame === null) break
      frames.push(frame)
    }
    return frames
  }

  #tryRead() {
    const b = this.#buf
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < off + 2) return null
      len = b.readUInt16BE(off)
      off += 2
    } else if (len === 127) {
      if (b.length < off + 8) return null
      const big = b.readBigUInt64BE(off)
      if (big > BigInt(MAX_PAYLOAD)) throw new Error(`frame de ${big} bytes excede o limite do spike`)
      len = Number(big)
      off += 8
    }
    if (len > MAX_PAYLOAD) throw new Error(`frame de ${len} bytes excede o limite do spike`)
    let mask = null
    if (masked) {
      if (b.length < off + 4) return null
      mask = b.subarray(off, off + 4)
      off += 4
    }
    if (b.length < off + len) return null
    const payload = Buffer.from(b.subarray(off, off + len))
    if (mask !== null) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    this.#buf = Buffer.from(b.subarray(off + len))
    return { fin, opcode, payload }
  }
}

/** Emite um frame FIN nao mascarado (lado servidor). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  let head
  if (body.length < 126) {
    head = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(body.length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([head, body])
}

export function encodeText(text) {
  return encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'))
}

export function encodeClose(code = 1000, reason = '') {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2, 'utf8')
  return encodeFrame(OPCODE.CLOSE, body)
}
