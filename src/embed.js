// Drawings in a note's live preview: the handle that resizes one, and the caret kept off a drawing's line.
const { editorLivePreviewField } = require('obsidian')
const { EditorState, EditorSelection } = require('@codemirror/state')
const { EditorView } = require('@codemirror/view')

/** a line with nothing on it but a drawing */
const DRAWING_LINE = /^\s*(?:!\[\[[^\]]+\.drawing\.png[^\]]*\]\]|!\[[^\]]*\]\(<?[^)>]+\.drawing\.png>?\))\s*$/
/** a drawing's link, either kind */
const DRAWING_LINK = /!\[\[([^\]]+?\.drawing\.png)([^\]]*)\]\]|!\[([^\]]*)\]\((<?[^)>]+\.drawing\.png>?)\)/g
/** a size in a link: `300` or `300x200` */
const SIZE = /^\s*\d+(?:x\d+)?\s*$/

const livePreview = (state) => {
  try { return !!state.field(editorLivePreviewField, false) } catch { return false }
}

/** the drawing's line the caret is on, if it's on one */
function drawingLineAt(state) {
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty || !livePreview(state)) return null
  const line = state.doc.lineAt(sel.main.head)
  return DRAWING_LINE.test(line.text) ? line : null
}

/** A caret on a drawing's line is as tall as the drawing, before it or after it. So the caret doesn't stop there:
 *  going forward (a click on the line, the down or right arrow) it goes on to the line after, going back (the up or
 *  left arrow) to the end of the line before. A drawing on the note's last line has nowhere after it; there the caret
 *  stays at the line's end, hidden, so Return or typing still go after the drawing. */
const skipDrawingLines = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr
  const sel = tr.newSelection
  if (sel.ranges.length > 1 || !sel.main.empty || !livePreview(tr.startState)) return tr
  const doc = tr.newDoc
  const line = doc.lineAt(sel.main.head)
  if (!DRAWING_LINE.test(line.text)) return tr
  const back = !tr.isUserEvent('select.pointer') && tr.startState.selection.main.head > sel.main.head
  // the nearest line that isn't a drawing's, that way; the end of the one before, the start of the one after
  const next = (n, step) => {
    for (; n >= 1 && n <= doc.lines; n += step) {
      const l = doc.line(n)
      if (!DRAWING_LINE.test(l.text)) return step < 0 ? l.to : l.from
    }
    return null
  }
  const to = (back ? next(line.number - 1, -1) ?? next(line.number + 1, 1) : next(line.number + 1, 1)) ?? line.to
  return to === sel.main.head ? tr : [tr, { selection: EditorSelection.cursor(to), sequential: true }]
})

const hideCaret = EditorView.editorAttributes.compute(['selection'], (state) =>
  drawingLineAt(state) ? { class: 'qd-caret-off' } : {})

const caretOffDrawings = [skipDrawingLines, hideCaret]

/** `link` (a drawing's whole link) at `width`, or at its own size for none */
function withWidth(link, width) {
  const size = (parts) => {
    if (parts.length && SIZE.test(parts[parts.length - 1])) parts.pop()
    if (width != null) parts.push(String(Math.round(width)))
    return parts
  }
  DRAWING_LINK.lastIndex = 0
  const m = DRAWING_LINK.exec(link)
  if (!m) return link
  if (m[1] != null) {
    const parts = m[2] ? m[2].slice(1).split('|') : []
    return `![[${[m[1], ...size(parts)].join('|')}]]`
  }
  const alt = size(m[3] ? m[3].split('|') : [])
  return `![${alt.join('|')}](${m[4]})`
}

/** the link of the drawing shown at `node` in `view`: where it is in the note and its text */
function linkAt(view, node) {
  let pos
  try { pos = view.posAtDOM(node) } catch { return null }
  const line = view.state.doc.lineAt(pos)
  let best = null
  DRAWING_LINK.lastIndex = 0
  for (let m; (m = DRAWING_LINK.exec(line.text));) {
    const from = line.from + m.index
    const to = from + m[0].length
    const d = pos < from ? from - pos : pos > to ? pos - to : 0
    if (!best || d < best.d) best = { from, to, text: m[0], d }
  }
  return best
}

/** A handle on the drawing's right edge: drag it to make the drawing wider or narrower, double click it to go back to
 *  the size it was drawn at. The drawing follows the pointer as it moves; the width goes into the link (`|300`) when
 *  the drag ends, as Obsidian's own handle on pictures does. */
function addSizeHandle(embed) {
  if (embed.querySelector(':scope > .qd-embed-size')) return
  const handle = document.createElement('div')
  handle.className = 'qd-embed-size'
  handle.setAttribute('aria-label', 'Drag to resize')
  embed.appendChild(handle)

  const imgOf = () => embed.querySelector('img[data-qd-base]') || embed.querySelector('img')
  const viewOf = () => (embed.closest('.cm-editor') ? EditorView.findFromDOM(embed.closest('.cm-editor')) : null)
  const write = (width) => {
    const view = viewOf()
    const link = view && linkAt(view, embed)
    if (!link) return
    const text = withWidth(link.text, width)
    if (text !== link.text) view.dispatch({ changes: { from: link.from, to: link.to, insert: text }, scrollIntoView: false })
  }

  handle.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  handle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation() })
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const img = imgOf()
    if (!img) return
    img.removeAttribute('width')
    img.removeAttribute('height')
    if (img.naturalWidth) img.style.width = `${Math.max(24, img.naturalWidth / 2)}px`
    write(null)
  })
  handle.addEventListener('pointerdown', (e) => {
    const img = imgOf()
    if (!e.isPrimary || e.button !== 0 || !img || !viewOf()) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = img.getBoundingClientRect().width
    const room = (embed.closest('.cm-line') || embed.parentElement || embed).clientWidth || Infinity
    let width = startW
    let x = startX
    let frame = 0
    img.removeAttribute('height')
    embed.classList.add('is-sizing')
    document.body.classList.add('qd-sizing')
    try { handle.setPointerCapture(e.pointerId) } catch {}
    const move = (ev) => {
      x = ev.clientX
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        width = Math.round(Math.min(room, Math.max(40, startW + x - startX)))
        img.style.width = `${width}px`
      })
    }
    const end = (ev) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      try { handle.releasePointerCapture(e.pointerId) } catch {}
      embed.classList.remove('is-sizing')
      document.body.classList.remove('qd-sizing')
      if (ev.type === 'pointercancel') {
        img.style.width = `${startW}px`
        return
      }
      width = Math.round(Math.min(room, Math.max(40, startW + ev.clientX - startX)))
      img.style.width = `${width}px`
      if (Math.abs(width - startW) >= 1) write(width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  })
}

module.exports = { caretOffDrawings, addSizeHandle, withWidth, DRAWING_LINE }
