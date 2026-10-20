// The computer's name on the local network, `<name>.local`, answered by the plugin itself with multicast DNS: when an
// iPad asks who `obsidian.local` is, this answers with the computer's address. It only ever answers for its one name,
// only while a drawing is shared, and only on the local network (multicast DNS never leaves it).

const dgram = require('node:dgram')

const GROUP = '224.0.0.251'
const PORT = 5353
const A = 1
const ANY = 255
const TTL = 120

/** the computer's address on the local network. A UDP socket "connected" to the multicast DNS group sends nothing; it
 *  only asks the system which of its addresses it would use there. Never a loopback or link-local one. */
function lanAddress() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    const done = (a) => {
      try { s.close() } catch {}
      resolve(a && a !== '0.0.0.0' && !a.startsWith('127.') && !a.startsWith('169.254.') ? a : null)
    }
    s.on('error', () => done(null))
    s.connect(PORT, GROUP, () => {
      let a = null
      try { a = s.address().address } catch {}
      done(a)
    })
  })
}

// ---- DNS messages: just enough for A records ----

function encodeName(name) {
  const parts = name.split('.').filter(Boolean)
  const out = []
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8')
    out.push(Buffer.from([b.length]), b)
  }
  out.push(Buffer.from([0]))
  return Buffer.concat(out)
}

/** a name at `at` (compression pointers followed); returns [name, the offset after it] */
function readName(buf, at) {
  const labels = []
  let end = -1
  for (let hops = 0; hops < 64; hops++) {
    if (at >= buf.length) throw new Error('short')
    const len = buf[at]
    if (len === 0) { at += 1; break }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = at + 2
      at = ((len & 0x3f) << 8) | buf[at + 1]
      continue
    }
    labels.push(buf.toString('utf8', at + 1, at + 1 + len))
    at += 1 + len
  }
  return [labels.join('.').toLowerCase(), end >= 0 ? end : at]
}

function parse(buf) {
  const flags = buf.readUInt16BE(2)
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)]
  let at = 12
  const questions = []
  for (let i = 0; i < counts[0]; i++) {
    const [name, next] = readName(buf, at)
    questions.push({ name, type: buf.readUInt16BE(next), unicast: (buf.readUInt16BE(next + 2) & 0x8000) !== 0 })
    at = next + 4
  }
  const answers = []
  for (let i = 0; i < counts[1] + counts[2] + counts[3]; i++) {
    const [name, next] = readName(buf, at)
    const type = buf.readUInt16BE(next)
    const len = buf.readUInt16BE(next + 8)
    const data = next + 10
    answers.push({ name, type, ip: type === A && len === 4 ? [0, 1, 2, 3].map((i) => buf[data + i]).join('.') : null })
    at = next + 10 + len
  }
  return { id: buf.readUInt16BE(0), response: (flags & 0x8000) !== 0, questions, answers }
}

function query(name) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(ANY, 0)
  tail.writeUInt16BE(1, 2)
  return Buffer.concat([header, encodeName(name), tail])
}

/** an answer that `name` is at `ip`; `ttl` 0 says it no longer is */
function answer(name, ip, ttl = TTL, { id = 0, question = null } = {}) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(question ? 1 : 0, 4)
  header.writeUInt16BE(1, 6)
  const parts = [header]
  if (question) {
    const q = Buffer.alloc(4)
    q.writeUInt16BE(A, 0)
    q.writeUInt16BE(1, 2)
    parts.push(encodeName(name), q)
  }
  const rr = Buffer.alloc(14)
  rr.writeUInt16BE(A, 0)
  // class IN, and the cache-flush bit: this is the one answer for the name
  rr.writeUInt16BE(question ? 1 : 0x8001, 2)
  rr.writeUInt32BE(ttl, 4)
  rr.writeUInt16BE(4, 8)
  ip.split('.').forEach((n, i) => rr.writeUInt8(Number(n), 10 + i))
  parts.push(encodeName(name), rr)
  return Buffer.concat(parts)
}

/** Holds `<base>.local` for `ip`: asks first whether anyone else has it, then answers for it. Resolves the name it
 *  holds, or null when every candidate was taken or the network wouldn't have it. */
async function claimName(candidates, ip) {
  let socket
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(PORT, () => {
        socket.off('error', reject)
        resolve()
      })
    })
    socket.addMembership(GROUP, ip)
    socket.setMulticastInterface(ip)
    socket.setMulticastTTL(255)
    socket.setMulticastLoopback(true)
  } catch {
    try { socket?.close() } catch {}
    return null
  }

  let held = null
  let probing = null
  let heard = false
  socket.on('error', () => {})
  socket.on('message', (buf, from) => {
    let m
    try { m = parse(buf) } catch { return }
    if (m.response) {
      // someone answering for the name with another address: it's theirs (the same address is this computer, as in
      // a second vault sharing at once, which is no conflict)
      if (probing && m.answers.some((a) => a.name === probing && a.ip && a.ip !== ip)) heard = true
      return
    }
    if (!held) return
    for (const q of m.questions) {
      if (q.name !== held || (q.type !== A && q.type !== ANY)) continue
      if (from.port !== PORT) {
        // a plain DNS query sent to the group: answered straight back, as plain DNS
        socket.send(answer(held, ip, 10, { id: m.id, question: true }), from.port, from.address)
      } else if (q.unicast) {
        socket.send(answer(held, ip), from.port, from.address)
      } else {
        socket.send(answer(held, ip), PORT, GROUP)
      }
    }
  })

  for (const base of candidates) {
    const name = `${base}.local`
    probing = name
    heard = false
    for (let i = 0; i < 3 && !heard; i++) {
      socket.send(query(name), PORT, GROUP)
      await new Promise((r) => setTimeout(r, 250))
    }
    probing = null
    if (heard) continue
    held = name
    // announced, twice, a second apart
    socket.send(answer(name, ip), PORT, GROUP)
    setTimeout(() => { if (held === name) socket.send(answer(name, ip), PORT, GROUP) }, 1000)
    break
  }
  if (!held) {
    try { socket.close() } catch {}
    return null
  }
  return {
    name: held,
    ip,
    release() {
      const name = held
      held = null
      try {
        socket.send(answer(name, ip, 0), PORT, GROUP, () => { try { socket.close() } catch {} })
      } catch {
        try { socket.close() } catch {}
      }
    },
  }
}

module.exports = { lanAddress, claimName }
