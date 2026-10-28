// Builds the plugin into dist/: main.js (the plugin, with the board inlined as one self-contained page, and the iPad's
// page and the Quickdraw engine built in for the iPad to load), styles.css and manifest.json: all a release carries.
// `--install <vault>` copies it into that vault's plugins and turns it on.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(root, 'dist')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// ---- the board: one page, nothing to load, for the sheet's frame ----
const page = fs.readFileSync(path.join(root, 'src/board.html'), 'utf8')
const m = page.match(/<script type="module">([\s\S]*?)<\/script>/)
const entry = path.join(root, 'src/.board-entry.js')
fs.writeFileSync(entry, m[1].replace("'./qd/index.js'", "'../engine/qd/index.js'"))
const bundled = await build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, minify: true, target: 'chrome120' })
fs.rmSync(entry)
const qd = path.join(root, 'engine/qd')
const css = fs.readFileSync(path.join(qd, 'quickdraw.css'), 'utf8').replace(/url\('\.\/fonts\/([^']+)'\)/g, (_, f) =>
  `url('data:font/woff2;base64,${fs.readFileSync(path.join(qd, 'fonts', f)).toString('base64')}')`)
const js = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const board = page
  .replace('<link rel="stylesheet" href="qd/quickdraw.css">', () => `<style>${css}</style>`)
  .replace(m[0], () => `<script>${js}</script>`)

/** the iPad's page and the engine it runs, by the path it asks for, base64 */
function engineFiles() {
  const files = { 'ipad.html': fs.readFileSync(path.join(root, 'engine/ipad.html')).toString('base64') }
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + '/')
      else if (/\.(js|css|woff2)$/.test(e.name)) files[rel + e.name] = fs.readFileSync(path.join(dir, e.name)).toString('base64')
    }
  }
  walk(qd, 'qd/')
  return files
}

// ---- the plugin ----
await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'chrome120',
  outfile: path.join(out, 'main.js'),
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', 'bufferutil', 'utf-8-validate'],
  define: {
    BOARD_HTML: JSON.stringify(board),
    ENGINE_FILES: JSON.stringify(engineFiles()),
    // ws's optional native speedups, off: it reads no environment, and needs no native modules
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  logLevel: 'warning',
})
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(out, 'styles.css'))
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(out, 'manifest.json'))
console.log('built', out)

const at = process.argv.indexOf('--install')
if (at > 0) {
  const VAULT = process.argv[at + 1]
  if (!VAULT || !fs.existsSync(path.join(VAULT, '.obsidian'))) throw new Error('--install needs a vault folder')
  const dest = path.join(VAULT, '.obsidian/plugins/quickdraw')
  fs.mkdirSync(dest, { recursive: true })
  for (const f of ['main.js', 'styles.css', 'manifest.json']) fs.copyFileSync(path.join(out, f), path.join(dest, f))
  const list = path.join(VAULT, '.obsidian/community-plugins.json')
  let on = []
  try { on = JSON.parse(fs.readFileSync(list, 'utf8')) } catch {}
  if (!on.includes('quickdraw')) fs.writeFileSync(list, JSON.stringify([...on, 'quickdraw'], null, 2))
  console.log('installed', dest)
}
