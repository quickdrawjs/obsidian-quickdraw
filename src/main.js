// Quickdraw in Obsidian, as Consonance has it in its script: "Insert drawing" opens a sheet with the Quickdraw board,
// Draw on iPad, and Done. A new drawing goes into the note where the cursor was once there's something in it; it saves
// a moment after each change, so a stroke drawn on the iPad is soon in the note behind.
//
// A drawing is kept as a picture of itself, light and dark, with its strokes beside it: `<id>.drawing.png`,
// `<id>.drawing-dark.png` and `<id>.drawing.json`, in the folder the settings name (the vault's attachment folder
// unless they name another). The note embeds the picture, so any Markdown reader shows it; here the dark one shows in the dark
// theme, at its size (it's drawn at twice), and a double click on it opens it to draw on.
const { Plugin, PluginSettingTab, Setting, MarkdownView, TFile, Notice, Platform, FileSystemAdapter, normalizePath, setIcon, addIcon } = require('obsidian')
// the browser build: it draws the code on a canvas, with no file system
const QRCode = require('qrcode/lib/browser')
const { createIpadBridge } = require('./ipad')
const { caretOffDrawings, addSizeHandle } = require('./embed')

const DRAWING = '.drawing.png'
const DARK = '.drawing-dark.png'
const SOURCE = '.drawing.json'

const isDark = () => document.body.classList.contains('theme-dark')
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
const icon = (cls, name) => {
  const e = el('span', cls)
  setIcon(e, name)
  return e
}
const bytes = (base64) => {
  const b = Buffer.from(base64, 'base64')
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

/** Quickdraw's mark, as on its site and in the board's corner: the stroke in the text colour, the dot in its blue. Drawn
 *  on a 32 grid, fitted to the 100 one Obsidian's icons use. */
const MARK = '<g transform="translate(-12.1 -7.8) scale(3.6)">' +
  '<path d="M7 21 C7 12, 13 6.5, 20 7.5 C26.5 8.5, 27.5 16, 22 18.8 C17.5 21, 13 19.5, 14 15" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>' +
  '<circle cx="24.5" cy="24.5" r="2.6" fill="#2f6fed"/></g>'

module.exports = class QuickdrawPlugin extends Plugin {
  async onload() {
    addIcon('quickdraw', MARK)
    this.settings = Object.assign({ folder: '', hostId: '', ipadKey: '' }, await this.loadData())
    this.addSettingTab(new QuickdrawSettings(this))
    const adapter = this.app.vault.adapter
    this.basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : ''
    // The iPad's page and the engine, served from here: built into the plugin, nothing on disk.
    // eslint-disable-next-line no-undef
    const files = Object.fromEntries(Object.entries(ENGINE_FILES).map(([k, v]) => [k, Buffer.from(v, 'base64')]))
    this.bridge = createIpadBridge({
      files,
      hostId: {
        get: () => this.settings.hostId,
        set: (id) => { this.settings.hostId = id; this.saveData(this.settings) },
      },
      savedKey: {
        get: () => this.settings.ipadKey,
        set: (k) => { this.settings.ipadKey = k; this.saveData(this.settings) },
      },
    })
    this.sheet = null
    this.registerEditorExtension(caretOffDrawings)

    this.addCommand({
      id: 'insert-drawing',
      name: 'Insert drawing',
      icon: 'quickdraw',
      editorCallback: (editor, ctx) => this.newDrawing(editor, ctx),
    })
    this.addCommand({
      id: 'edit-drawing',
      name: 'Draw on the drawing at the cursor',
      icon: 'pencil',
      editorCheckCallback: (checking, editor, ctx) => {
        const base = this.drawingOnLine(editor, ctx.file)
        if (!base) return false
        if (!checking) this.openDrawing({ base, notePath: ctx.file.path, editor: null, insertAt: null })
        return true
      },
    })
    this.addRibbonIcon('quickdraw', 'Insert drawing', () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      if (!view || !view.file) return new Notice('Open a note to draw in.')
      this.newDrawing(view.editor, view)
    })
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, ctx) => {
        if (!ctx.file) return
        menu.addItem((i) => i.setTitle('Insert drawing').setIcon('quickdraw').onClick(() => this.newDrawing(editor, ctx)))
        const base = this.drawingOnLine(editor, ctx.file)
        if (base) menu.addItem((i) => i.setTitle('Draw on drawing').setIcon('pencil').onClick(() => this.openDrawing({ base, notePath: ctx.file.path, editor: null, insertAt: null })))
      }),
    )

    // Drawings in notes, wherever they're shown: the right picture for the theme, at its size.
    let queued = false
    const scanSoon = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        this.scan()
      })
    }
    this.observer = new MutationObserver(scanSoon)
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] })
    this.register(() => this.observer.disconnect())
    this.app.workspace.onLayoutReady(scanSoon)
    this.registerEvent(this.app.vault.on('create', scanSoon))
    this.registerEvent(this.app.vault.on('delete', scanSoon))

    // A double click on one opens it to draw on. Its clicks are the drawing's: Obsidian's image viewer doesn't open
    // over it, and its own double click on an image doesn't go through either.
    const drawingAt = (e) => {
      const img = e.target instanceof HTMLElement && e.target.closest('img[data-qd-base]')
      return img && !img.closest('.qd-veil') ? img : null
    }
    this.registerDomEvent(document, 'click', (e) => {
      if (!drawingAt(e)) return
      e.preventDefault()
      e.stopPropagation()
    }, true)
    this.registerDomEvent(document, 'dblclick', (e) => {
      const img = drawingAt(e)
      if (!img) return
      e.preventDefault()
      e.stopPropagation()
      this.openFromEmbed(img)
    }, true)
  }

  onunload() {
    this.sheet?.close()
    this.bridge.stop()
  }

  // ---- where drawings are ----------------------------------------------------------------

  /** a vault path for a picture shown at `src` (app://…/<absolute path>?mtime) */
  vaultPathOf(src) {
    try {
      // Windows paths come as /C:/…
      const p = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1')
      const base = this.basePath.replace(/\\/g, '/')
      if (base && p.startsWith(base + '/')) return p.slice(base.length + 1)
    } catch {}
    return null
  }

  baseOf(p) {
    if (!p) return null
    if (p.endsWith(DARK)) return p.slice(0, -DARK.length)
    if (p.endsWith(DRAWING)) return p.slice(0, -DRAWING.length)
    return null
  }

  /** the drawing embedded on the cursor's line, if there's one */
  drawingOnLine(editor, file) {
    if (!file) return null
    const line = editor.getLine(editor.getCursor().line)
    const m = line.match(/!\[\[([^\]|#]+\.drawing\.png)[^\]]*\]\]|!\[[^\]]*\]\(<?([^)>]+\.drawing\.png)>?\)/)
    if (!m) return null
    const link = decodeURIComponent((m[1] || m[2]).trim())
    const f = this.app.metadataCache.getFirstLinkpathDest(link, file.path)
    return f ? this.baseOf(f.path) : null
  }

  /** where a new drawing for `notePath` goes: the folder the settings name, else the vault's attachment folder */
  async folderFor(notePath, name) {
    const named = normalizePath(this.settings.folder.trim() || '/')
    if (named !== '/') return named
    const p = await this.app.fileManager.getAvailablePathForAttachment(name, notePath)
    return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
  }

  /** the note's view holding `node`, if one does */
  viewHolding(node) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view.containerEl.contains(node)) return leaf.view
    }
    return null
  }

  // ---- drawings shown in notes -----------------------------------------------------------

  scan() {
    for (const img of document.querySelectorAll('img')) {
      if (img.closest('.qd-veil')) continue
      const src = img.getAttribute('src') || ''
      if (!src.includes('.drawing')) continue
      const base = this.baseOf(this.vaultPathOf(src))
      if (base) this.show(img, base)
    }
  }

  show(img, base) {
    const vault = this.app.vault
    img.dataset.qdBase = base
    img.draggable = false
    const dark = isDark() && vault.getAbstractFileByPath(base + DARK) instanceof TFile
    const f = vault.getAbstractFileByPath(base + (dark ? DARK : DRAWING))
    if (f instanceof TFile) {
      const url = vault.getResourcePath(f)
      if (img.getAttribute('src') !== url) img.setAttribute('src', url)
    }
    if (!img.dataset.qdSized) {
      img.dataset.qdSized = '1'
      // a drawing's picture is at twice its size
      // a width in the link (`|300`) is the size it was given instead
      const size = () => {
        if (img.getAttribute('width')) img.style.width = ''
        else if (img.naturalWidth) img.style.width = `${Math.max(24, img.naturalWidth / 2)}px`
      }
      img.addEventListener('load', size)
      if (img.complete) size()
    }
    const embed = img.closest('.internal-embed') || img.parentElement
    if (embed && !embed.classList.contains('qd-drawing')) {
      embed.classList.add('qd-drawing')
      const b = icon('qd-embed-draw', 'pencil')
      b.setAttribute('aria-label', 'Draw')
      b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const i = embed.querySelector('img[data-qd-base]')
        if (i) this.openFromEmbed(i)
      })
      embed.appendChild(b)
    }
    if (embed && embed.closest('.cm-editor')) addSizeHandle(embed)
  }

  /** a drawing written again: every picture of it shown anew */
  refresh(base) {
    for (const img of document.querySelectorAll('img[data-qd-base]')) {
      if (img.dataset.qdBase === base) this.show(img, base)
    }
  }

  // ---- opening one -------------------------------------------------------------------------

  async newDrawing(editor, ctx) {
    const file = ctx.file
    if (!file) return new Notice('Open a note to draw in.')
    const id = crypto.randomUUID().toLowerCase()
    const folder = await this.folderFor(file.path, id + DRAWING)
    const insertAt = editor.posToOffset(editor.getCursor('from'))
    this.openDrawing({ base: (folder ? folder + '/' : '') + id, notePath: file.path, editor, insertAt })
  }

  openFromEmbed(img) {
    const base = img.dataset.qdBase
    const view = this.viewHolding(img)
    const notePath = view?.file?.path || this.app.workspace.getActiveFile()?.path || null
    this.openDrawing({ base, notePath, editor: null, insertAt: null })
  }

  openDrawing(request) {
    if (this.sheet) return
    this.sheet = new DrawingSheet(this, request, () => { this.sheet = null })
  }

  // ---- keeping one ---------------------------------------------------------------------------

  async loadDrawing(base) {
    const a = this.app.vault.adapter
    try { return (await a.exists(base + SOURCE)) ? await a.read(base + SOURCE) : null } catch { return null }
  }

  /** its strokes, and a picture of it for each theme; a picture that's null goes */
  async saveDrawing(base, { snapshot, light, dark }) {
    const vault = this.app.vault
    const folder = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
    if (folder && !(await vault.adapter.exists(folder))) await vault.createFolder(folder).catch(() => {})
    if (typeof snapshot === 'string') await vault.adapter.write(base + SOURCE, snapshot)
    for (const [suffix, data] of [[DRAWING, light], [DARK, dark]]) {
      const p = base + suffix
      const f = vault.getAbstractFileByPath(p)
      if (data) {
        if (f instanceof TFile) await vault.modifyBinary(f, bytes(data))
        else await vault.createBinary(p, bytes(data))
      } else if (f instanceof TFile) {
        await vault.delete(f)
      }
    }
    this.refresh(base)
  }

  /** a new drawing has something in it: the note takes it where the cursor was, on a line of its own */
  async insertEmbed(request) {
    const { base, notePath, editor } = request
    const note = this.app.vault.getAbstractFileByPath(notePath)
    const pic = this.app.vault.getAbstractFileByPath(base + DRAWING)
    if (!(note instanceof TFile) || !(pic instanceof TFile)) return
    const line = '!' + this.app.fileManager.generateMarkdownLink(pic, notePath)
    const place = (doc, at) => {
      const from = Math.min(Math.max(at, 0), doc.length)
      const lead = from > 0 && doc[from - 1] !== '\n'
      let block = (lead ? '\n' : '') + line
      if (from >= doc.length || doc[from] !== '\n') block += '\n'
      // at the end of the note, onto the line below; otherwise just after it
      return { from, block, caret: from + (lead ? 1 : 0) + line.length + (from >= doc.length ? 1 : 0) }
    }
    const live = editor && this.app.workspace.getLeavesOfType('markdown').some((l) => l.view.editor === editor && l.view.file?.path === notePath)
    if (live) {
      const { from, block, caret } = place(editor.getValue(), request.insertAt ?? 0)
      editor.replaceRange(block, editor.offsetToPos(from))
      editor.setCursor(editor.offsetToPos(Math.min(caret, editor.getValue().length)))
    } else {
      await this.app.vault.process(note, (doc) => {
        const { from, block } = place(doc, request.insertAt ?? doc.length)
        return doc.slice(0, from) + block + doc.slice(from)
      })
    }
  }

  /** done with nothing left in it: out of the note, and its files to the trash */
  async removeDrawing(request) {
    const { base, notePath } = request
    const name = base.split('/').pop() + DRAWING
    const strip = (doc) => doc.split('\n').filter((l) => !(l.includes(name) && /^\s*!\[/.test(l))).join('\n')
    const note = notePath && this.app.vault.getAbstractFileByPath(notePath)
    if (note instanceof TFile) {
      const leaf = this.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === notePath)
      const editor = leaf?.view.editor
      if (editor) {
        for (let i = editor.lineCount() - 1; i >= 0; i--) {
          const l = editor.getLine(i)
          if (l.includes(name) && /^\s*!\[/.test(l)) {
            const last = i === editor.lineCount() - 1
            editor.replaceRange('', last && i > 0 ? { line: i - 1, ch: editor.getLine(i - 1).length } : { line: i, ch: 0 }, last ? { line: i, ch: l.length } : { line: i + 1, ch: 0 })
          }
        }
      } else {
        await this.app.vault.process(note, strip)
      }
    }
    const a = this.app.vault.adapter
    for (const suffix of [DRAWING, DARK, SOURCE]) {
      const f = this.app.vault.getAbstractFileByPath(base + suffix)
      try {
        if (f instanceof TFile) await this.app.vault.trash(f, true)
        else if (await a.exists(base + suffix)) await a.trashSystem(base + suffix)
      } catch {}
    }
  }
}

// ---- the sheet ------------------------------------------------------------------------------------

/** A drawing, big: the board with Quickdraw's tools, Draw on iPad, and Done. It saves a moment after each change, and
 *  every few seconds through a long run of them, so a stroke drawn on the iPad is soon in the note behind. */
class DrawingSheet {
  constructor(plugin, request, onClosed) {
    this.plugin = plugin
    this.request = request
    this.onClosed = onClosed
    this.ready = false
    this.inNote = request.insertAt == null
    this.saving = false
    this.saveAgain = false
    this.finished = false
    this.closing = false
    this.changedSince = null
    this.timer = null
    this.calls = new Map()
    this.next = 1
    this.ipad = { state: 'off' }
    this.ipadOn = false
    this.showingCode = false
    this.build()
  }

  build() {
    const veil = (this.veil = el('div', 'qd-veil'))
    const sheet = el('div', 'qd-sheet')
    sheet.addEventListener('mousedown', (e) => e.stopPropagation())
    const head = el('header', 'qd-head')
    head.append(
      icon('qd-glyph', 'quickdraw'),
      el('h3', null, this.request.insertAt == null ? 'Drawing' : 'New drawing'),
      el('span', 'qd-in', 'in the note'),
      el('span', 'spacer'),
    )
    this.wrap = el('div', 'qd-ipad-wrap')
    this.ipadBtn = el('button', 'qd-ipad-btn')
    this.ipadBtn.addEventListener('click', () => (this.showingCode ? this.setShowingCode(false) : this.startIpad()))
    this.wrap.append(this.ipadBtn)
    this.doneBtn = el('button', 'qd-gold')
    this.doneBtn.append('Done ', el('span', 'k', Platform.isMacOS ? '⌘↩' : 'Ctrl ↩'))
    this.doneBtn.addEventListener('click', () => this.done())
    head.append(this.wrap, this.doneBtn)

    const board = el('div', 'qd-board')
    this.frame = el('iframe')
    this.frame.title = 'Drawing board'
    this.spin = el('div', 'qd-spin')
    board.append(this.frame, this.spin)
    sheet.append(head, board)
    veil.append(sheet)

    this.onMessage = (e) => this.message(e)
    this.onKey = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        this.done()
      }
    }
    this.onOutside = (e) => {
      if (this.showingCode && !(e.target instanceof Element && e.target.closest('.qd-ipad-wrap'))) this.setShowingCode(false)
    }
    window.addEventListener('message', this.onMessage)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('mousedown', this.onOutside, true)
    document.body.appendChild(veil)
    this.renderIpad()
    // eslint-disable-next-line no-undef
    this.frame.srcdoc = BOARD_HTML
  }

  call(name, ...args) {
    return new Promise((resolve) => {
      const id = this.next++
      const target = this.frame?.contentWindow
      // gone with the sheet: nothing to answer
      if (!target) return resolve(null)
      this.calls.set(id, resolve)
      target.postMessage({ call: name, id, args }, '*')
    })
  }

  async message(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return
    const m = e.data || {}
    if (m.reply != null) {
      const resolve = this.calls.get(m.reply)
      this.calls.delete(m.reply)
      resolve?.(m.result)
      return
    }
    switch (m.qd) {
      case 'ready': {
        const json = await this.plugin.loadDrawing(this.request.base)
        await this.call('load', json, isDark() ? 'dark' : 'light')
        this.ready = true
        this.frame.classList.add('ready')
        this.spin.remove()
        this.frame.focus()
        break
      }
      case 'changed':
        this.changed()
        break
      case 'toIpad':
        if (typeof m.body === 'string') this.plugin.bridge.send(m.body)
        break
      case 'exportImage':
        if (typeof m.body === 'string' && m.body) this.exportImage(m.body)
        break
      case 'done':
        this.done()
        break
    }
  }

  async exportImage(base64) {
    try {
      // A download: the computer's own save panel.
      const url = URL.createObjectURL(new Blob([bytes(base64)], { type: 'image/png' }))
      const a = el('a')
      a.href = url
      a.download = 'Drawing.png'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      console.error(err)
      new Notice("Couldn't export the drawing.")
    }
  }

  /** writes the drawing now: its strokes, and a picture of it for each theme; resolves whether there's nothing in it */
  async save() {
    if (!this.ready) return !this.inNote
    if (this.saving) {
      this.saveAgain = true
      return false
    }
    this.saving = true
    clearTimeout(this.timer)
    this.timer = null
    this.changedSince = null
    try {
      const r = await this.call('save')
      if (!r) return false
      if (r.empty && !this.inNote) return true
      try {
        await this.plugin.saveDrawing(this.request.base, { snapshot: r.snapshot, light: r.light, dark: r.dark })
      } catch (err) {
        console.error("Couldn't save the drawing", err)
        new Notice("Couldn't save the drawing.")
        return r.empty
      }
      if (!r.empty && !this.inNote) {
        this.inNote = true
        await this.plugin.insertEmbed(this.request)
      }
      return r.empty
    } finally {
      this.saving = false
      if (this.saveAgain) {
        this.saveAgain = false
        this.changed()
      }
    }
  }

  changed() {
    const since = this.changedSince ?? Date.now()
    this.changedSince = since
    clearTimeout(this.timer)
    // A moment after the last change, and never more than a few seconds after the first unsaved one.
    const wait = Math.max(0, Math.min(800, 4000 - (Date.now() - since)))
    this.timer = setTimeout(() => this.save(), wait)
  }

  // ---- Draw on iPad ----

  fromIpad(text) {
    if (this.ready) this.call('fromIpad', text)
  }

  stopIpad() {
    if (!this.ipadOn) return
    this.ipadOn = false
    this.plugin.bridge.stop()
    this.ipad = { state: 'off' }
    this.showingCode = false
    this.renderIpad()
    this.fromIpad('{"type":"presence","ipads":0}')
  }

  async startIpad() {
    this.setShowingCode(true)
    if (this.ipad.state === 'starting' || this.ipad.state === 'sharing') return
    this.ipad = { state: 'starting', devices: 0 }
    this.ipadOn = true
    this.renderIpad()
    try {
      const a = await this.plugin.bridge.start(
        (text) => this.fromIpad(text),
        (count) => {
          if (this.ipad.devices !== count) {
            this.ipad = { ...this.ipad, devices: count }
            this.renderIpad()
          }
          this.fromIpad(`{"type":"presence","ipads":${count}}`)
        },
      )
      if (this.ipad.state !== 'starting') return
      this.ipad = { state: 'sharing', url: a.url, direct: a.direct, devices: this.ipad.devices ?? 0 }
      this.code = null
      // The code holds the address itself, which always opens; the name is there for typing.
      QRCode.toDataURL(a.direct, { errorCorrectionLevel: 'M', margin: 0, width: 432, color: { dark: '#000000', light: '#ffffff' } }).then(
        (code) => { this.code = code; this.renderIpad() },
        () => {},
      )
    } catch (err) {
      this.ipad = { state: 'failed', message: String(err?.message || err) }
    }
    this.renderIpad()
  }

  setShowingCode(on) {
    this.showingCode = on
    this.renderIpad()
  }

  renderIpad() {
    const ipad = this.ipad
    const connected = ipad.state === 'sharing' ? ipad.devices : 0
    const sharing = ipad.state === 'sharing' || ipad.state === 'starting'
    const b = this.ipadBtn
    b.className = 'qd-ipad-btn' + (this.showingCode ? ' on' : '') + (connected ? ' live' : '')
    b.title = connected ? 'An iPad is drawing on this' : 'Draw on this from your iPad, with Apple Pencil'
    b.replaceChildren(icon('qd-tablet', 'tablet'), connected ? (connected === 1 ? 'iPad connected' : `${connected} iPads connected`) : 'Draw on iPad')
    if (sharing) b.append(el('i', 'qd-dot' + (connected ? ' yes' : '')))

    this.wrap.querySelector('.qd-pop')?.remove()
    if (!this.showingCode) return
    const pop = el('div', 'qd-pop')
    pop.append(el('div', 'qd-pop-title', 'Draw on iPad'))
    const shown = (url) => url.replace(/^http:\/\//, '')
    const tiny = (text, fn) => {
      const t = el('button', 'qd-tiny', text)
      t.addEventListener('click', fn)
      return t
    }
    if (ipad.state === 'failed') {
      const row = el('div', 'qd-row')
      row.append(el('span', 'spacer'), tiny('Try Again', () => this.startIpad()))
      pop.append(el('p', 'qd-msg', ipad.message), row)
    } else if (ipad.state !== 'sharing') {
      const wait = el('div', 'qd-code wait')
      wait.append(el('div', 'qd-spin small'))
      pop.append(wait)
    } else {
      if (ipad.devices > 0) {
        const live = el('div', 'qd-live')
        const text = el('div')
        text.append(
          el('div', 'qd-live-t', ipad.devices === 1 ? 'Your iPad is connected' : `${ipad.devices} iPads are connected`),
          el('div', 'qd-live-d', 'Draw with Apple Pencil; what you draw lands here and in the note. Fingers pan and zoom.'),
        )
        live.append(el('i', 'qd-dot yes big'), text)
        pop.append(live)
      } else {
        const code = el('div', 'qd-code')
        if (this.code) {
          const img = el('img')
          img.src = this.code
          img.alt = 'A code to open this drawing on your iPad'
          code.append(img)
        }
        const steps = el('ol', 'qd-steps')
        for (const [n, t] of [['1', `Put your iPad on the same Wi-Fi as this ${Platform.isMacOS ? 'Mac' : 'computer'}.`], ['2', 'Open the Camera and point it at the code.'], ['3', 'Tap the link: the drawing opens in Safari, ready for Pencil.']]) {
          const li = el('li')
          li.append(el('b', null, n), t)
          steps.append(li)
        }
        pop.append(code, steps)
      }
      const addr = el('div', 'qd-addr')
      addr.title = 'Or type this address into Safari'
      addr.append(el('div', 'a', shown(ipad.url)))
      if (ipad.direct !== ipad.url) addr.append(el('div', 'b', `or ${shown(ipad.direct)}`))
      const row = el('div', 'qd-row')
      if (ipad.devices > 0) row.append(el('span', 'qd-again', 'Scan again to add another iPad.'))
      row.append(el('span', 'spacer'), tiny('Stop Sharing', () => this.stopIpad()))
      pop.append(addr, row)
    }
    this.wrap.append(pop)
  }

  // ---- done ----

  /** done: saved for the last time, the iPad let go, and, emptied, gone from the note */
  async finish() {
    if (this.finished) return
    this.finished = true
    const empty = await this.save()
    this.stopIpad()
    if (empty && this.inNote) await this.plugin.removeDrawing(this.request)
  }

  async done() {
    if (this.closing) return
    this.closing = true
    this.doneBtn.disabled = true
    await this.finish()
    this.close()
  }

  /** however the sheet goes, what's drawn is kept */
  close() {
    if (!this.veil) return
    if (!this.finished) {
      // Closing without Done (the plugin going): one last save first.
      this.finish().finally(() => this.close())
      return
    }
    window.removeEventListener('message', this.onMessage)
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('mousedown', this.onOutside, true)
    this.veil.remove()
    this.veil = null
    this.frame = null
    this.onClosed()
    // back to writing
    this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.editor.focus()
  }
}

// ---- settings ----------------------------------------------------------------------------------------

class QuickdrawSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()
    new Setting(containerEl)
      .setName('Folder for drawings')
      .setDesc('Where new drawings are kept, each as a picture for light and dark themes and its strokes. Leave empty to use the folder set for attachments in Files and links.')
      .addText((t) =>
        t.setPlaceholder('attachments').setValue(this.plugin.settings.folder).onChange(async (v) => {
          this.plugin.settings.folder = v
          await this.plugin.saveData(this.plugin.settings)
        }),
      )
  }
}
