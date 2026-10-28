// Draw on iPad: a small server on the local network that an iPad opens by scanning a code. It serves one page and
// the Quickdraw engine the Mac's board runs, and relays messages between the iPad and the drawing open in Obsidian
// over a WebSocket. The Mac's drawing stays the one that's kept; the iPad is a second pen on it.
//
// The code holds the computer's address, which always works. For typing, there's a name too, `obsidian.local`, which
// the plugin answers for itself with multicast DNS while it shares (src/mdns.js); on port 80 when that's free.
//
// Every address carries a random key, kept from one sharing to the next, so only someone who scanned the code can load
// the page or join, and a page left open on the iPad reconnects when the next drawing is shared. The server listens
// only while a drawing is being shared, and stops with it.

const http = require('node:http')
const { lanAddress, claimName } = require('./mdns')
const { WebSocketServer } = require('ws')

/** port 80 first, for an address with no port in it; then ports of its own */
const PORTS = [80, ...Array.from({ length: 20 }, (_, i) => 5791 + i)]
const HOST = 'obsidian'
const LETTERS = '23456789abcdefghjkmnpqrstuvwxyz'
/** the most one message may hold: a drawing with pictures in it, whole */
const LARGEST = 64 << 20

const randomKey = (n) => Array.from({ length: n }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('')

const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8' }

/** `files`: the iPad's page and the engine, by path ('ipad.html', 'qd/index.js', …), as Buffers; `hostId`: this
 *  computer's own short id, and `savedKey`: the key in the iPad's link, each made once and kept, as get/set */
function createIpadBridge({ files, hostId, savedKey }) {
  let server = null
  let wss = null
  let port = null
  let key = null
  let onMessage = null
  let onPresence = null
  const sockets = new Set()
  /** the name on the network, while it's held: { name, ip, release } */
  let claimed = null

  const devices = () => sockets.size
  const hasEngine = () => !!files['qd/index.js']

  /** this Mac's own short id, made once and kept */
  function machineID() {
    const kept = hostId.get()
    if (kept && kept.length === 4) return kept
    const id = randomKey(4)
    hostId.set(id)
    return id
  }

  /** the key in the iPad's link, made once and kept, so the link stays the same from one drawing to the next */
  function linkKey() {
    const kept = savedKey.get()
    if (kept && kept.length === 10) return kept
    const k = randomKey(10)
    savedKey.set(k)
    return k
  }

  function release() {
    if (claimed) claimed.release()
    claimed = null
  }

  async function claim(ip) {
    if (claimed && claimed.ip === ip) return claimed.name
    release()
    const id = machineID()
    claimed = await claimName([HOST, `${HOST}-${id}`, `${HOST}-${id}-${10 + Math.floor(Math.random() * 90)}`], ip)
    return claimed ? claimed.name : null
  }

  function route(p) {
    if (!key || !p.startsWith('/')) return { kind: 'expired' }
    const rest = p.slice(1)
    if (!rest.startsWith(key)) return { kind: 'expired' }
    const tail = rest.slice(key.length)
    if (tail === '') return { kind: 'redirect', to: `/${key}/` }
    if (tail === '/') return { kind: 'page' }
    if (!tail.startsWith('/qd/')) return { kind: 'missing' }
    // Only the engine's own files.
    const file = tail.slice(1)
    if (!Object.prototype.hasOwnProperty.call(files, file)) return { kind: 'missing' }
    return { kind: 'file', file }
  }

  function serve(req, res) {
    const reply = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': extra.cache || 'no-cache', Connection: 'close', ...extra.headers })
      res.end(body)
    }
    if (req.method !== 'GET') return reply(405, 'text/plain', '')
    let p = (req.url || '/').split('?')[0]
    try { p = decodeURIComponent(p) } catch {}
    const r = route(p)
    switch (r.kind) {
      case 'page':
        return reply(200, TYPES.html, files['ipad.html'], { cache: 'no-store' })
      case 'file':
        return reply(200, TYPES[r.file.split('.').pop().toLowerCase()] || 'application/octet-stream', files[r.file])
      case 'redirect':
        return reply(301, 'text/plain', '', { headers: { Location: r.to } })
      case 'expired':
        return reply(404, 'text/plain; charset=utf-8', 'This link has expired. Scan the code in Obsidian again.')
      default:
        return reply(404, 'text/plain', 'not found')
    }
  }

  function listenOn(n) {
    return new Promise((resolve) => {
      const s = http.createServer(serve)
      s.once('error', () => resolve(null))
      s.listen(n, '0.0.0.0', () => resolve(s))
    })
  }

  async function listen() {
    for (const n of PORTS) {
      const s = await listenOn(n)
      if (!s) continue
      server = s
      port = n
      // An iPad put to sleep leaves its socket open; keepalives find it gone.
      server.on('connection', (socket) => socket.setKeepAlive(true, 10_000))
      server.on('error', () => stop())
      wss = new WebSocketServer({ noServer: true, maxPayload: LARGEST })
      server.on('upgrade', (req, socket, head) => {
        let p = (req.url || '/').split('?')[0]
        try { p = decodeURIComponent(p) } catch {}
        const live = route(p).kind === 'page'
        wss.handleUpgrade(req, socket, head, (ws) => {
          // An old code's iPad is told the sharing's over, so it stops trying.
          if (!live) return ws.close(4001)
          sockets.add(ws)
          ws.on('message', (data) => onMessage && onMessage(String(data)))
          ws.on('close', () => {
            if (sockets.delete(ws)) onPresence && onPresence(devices())
          })
          ws.on('error', () => {})
          onPresence && onPresence(devices())
          onMessage && onMessage('{"type":"join"}')
        })
      })
      return
    }
    throw new Error('No port was free to share the drawing on. Quit an app that might be using one and try again.')
  }

  /** starts sharing, or goes on with the sharing already started; resolves where the iPad opens it */
  async function start(messages, presence) {
    const ip = await lanAddress()
    if (!ip) throw new Error("This computer isn't on a network. Join the same Wi-Fi as your iPad and try again.")
    if (!hasEngine()) throw new Error('The drawing engine for the iPad is missing from this build.')
    if (!server) await listen()
    key = linkKey()
    onMessage = messages
    onPresence = presence
    presence(devices())
    const host = (await claim(ip)) || ip
    const at = port === 80 ? '' : `:${port}`
    return { url: `http://${host}${at}/${key}/`, direct: `http://${ip}${at}/${key}/` }
  }

  /** to every iPad connected */
  function send(text) {
    for (const ws of sockets) if (ws.readyState === 1) ws.send(String(text))
  }

  /** stops sharing: the iPads are told it's over, and the server stops listening */
  function stop() {
    onMessage = null
    onPresence = null
    for (const ws of sockets) try { ws.close(4000) } catch {}
    sockets.clear()
    if (wss) try { wss.close() } catch {}
    if (server) try { server.close(); server.closeAllConnections?.() } catch {}
    wss = null
    server = null
    port = null
    key = null
    release()
  }

  return { start, send, stop }
}

module.exports = { createIpadBridge }
