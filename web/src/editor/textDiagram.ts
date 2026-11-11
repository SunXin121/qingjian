// Text diagram blocks (文本绘图): ```mermaid / ```dot code blocks get their own node view
// with a two-way switch between the renderers, code on the left and a live preview on the
// right while editing, and only the rendered diagram otherwise.
//
// It extends Milkdown's CodeMirrorBlock so the CodeMirror <-> ProseMirror syncing, keymaps
// and lazy (on-screen only) CodeMirror setup are reused; only the UI around it is replaced.
// The markdown stays a plain fenced code block.

import { nodeViewCtx, SchemaReady } from '@milkdown/kit/core'
import { CodeMirrorBlock, codeBlockConfig } from '@milkdown/kit/component/code-block'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeViewConstructor } from '@milkdown/kit/prose/view'
import { $viewAsync } from '@milkdown/kit/utils'
import DOMPurify from 'dompurify'
import './textDiagram.css'
import { getConfig } from '../api'
import { toast } from '../components/dialog'
import { withLangInput } from './langInput'
import { deleteBlockAt, isPreviewBlock } from './previewBlocks'
import { DIAGRAM_TEMPLATES, renderTextDiagram, textDiagramLang, type TextDiagramLang } from './previews'

const LANGS: { lang: TextDiagramLang; label: string }[] = [
  { lang: 'mermaid', label: 'Mermaid' },
  { lang: 'dot', label: 'Graphviz' },
  { lang: 'plantuml', label: 'PlantUML' },
]
const labelOf = (lang: TextDiagramLang) => LANGS.find((l) => l.lang === lang)!.label

// Same sanitising as Milkdown's own preview panel (SVG with foreignObject labels).
const purify = DOMPurify()
purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'foreignobject' && node.parentElement?.namespaceURI !== 'http://www.w3.org/2000/svg') {
    node.parentNode?.removeChild(node)
  }
})
const sanitize = (html: string) =>
  purify.sanitize(html, { ADD_TAGS: ['foreignObject'], ADD_ATTR: ['xmlns'], HTML_INTEGRATION_POINTS: { foreignobject: true } })

/** CodeMirrorBlock declares its internals private; we extend it untyped. */
const Base = CodeMirrorBlock as unknown as new (...args: any[]) => any

/** No CodeMirror language support for mermaid / dot: plain text editing. */
const noLanguages = { getAll: () => [], load: () => Promise.resolve(undefined) }

const RENDER_DELAY = 250

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const e = document.createElement(tag)
  e.className = className
  if (text) e.textContent = text
  return e
}

class TextDiagramView extends Base {
  declare dom: HTMLElement
  declare node: PMNode
  declare view: EditorView
  declare getPos: () => number | undefined

  private editing = false
  private ui: {
    switches: HTMLButtonElement[]
    code: HTMLElement
    preview: HTMLElement
    error: HTMLElement
    toggle: HTMLButtonElement
  } | null = null
  /** last successfully rendered diagram, kept on screen while the code has a syntax error */
  private lastHtml = ''
  private renderedKey = ''
  private renderSeq = 0
  private renderTimer: ReturnType<typeof setTimeout> | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, config: any, watchConfig: any) {
    super(node, view, getPos, noLanguages, config, watchConfig)
    this.dom.classList.add('ink-textdiagram')
    // replaces the Vue app the base class would mount around CodeMirror
    this.createApp = () => ({ mount: () => this.mountUI(), unmount: () => this.unmountUI() })
    this.dom.addEventListener('focusout', this.onFocusOut)
  }

  get lang(): TextDiagramLang {
    return textDiagramLang(this.node.attrs.language) ?? 'mermaid'
  }

  /** Shown until the block scrolls into view (and again after it left the screen for a while). */
  renderPlaceholder() {
    const ph = el('div', 'milkdown-code-block-placeholder ink-textdiagram-placeholder')
    if (this.lastHtml) ph.innerHTML = this.lastHtml
    else ph.appendChild(el('pre', '', this.node.textContent))
    this.dom.appendChild(ph)
  }

  private mountUI() {
    const bar = el('div', 'td-toolbar')
    const group = el('div', 'td-switch')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', '绘图语言')
    const switches = LANGS.map(({ lang, label }) => {
      const b = el('button', 'td-switch-item', label)
      b.type = 'button'
      b.dataset.lang = lang
      b.setAttribute('role', 'radio')
      b.onclick = () => this.switchLang(lang)
      group.appendChild(b)
      return b
    })
    // PlantUML needs a PlantUML server: offer it only when one is configured
    if (this.view.editable)
      getConfig().then(
        (c) => {
          const b = switches.find((x) => x.dataset.lang === 'plantuml')
          if (b && !c.plantuml && this.lang !== 'plantuml') b.hidden = true
        },
        () => {},
      )
    const copy = el('button', 'td-btn', '复制代码')
    copy.type = 'button'
    copy.onclick = () =>
      navigator.clipboard.writeText(this.node.textContent).then(
        () => toast('已复制'),
        () => toast('复制失败'),
      )
    // class names shared with regular code blocks: insertCodeBlock() uses them to open new blocks
    const toggle = el('button', 'td-btn primary preview-toggle-button', '完成')
    toggle.type = 'button'
    toggle.onclick = () => this.setEditing(!this.editing, true)
    const del = el('button', 'td-btn danger', '删除')
    del.type = 'button'
    del.title = '删除这个文本绘图'
    del.onclick = () => this.deleteBlock()
    bar.append(group, el('span', 'td-spacer'), del, copy, toggle)
    // keep focus in CodeMirror while using the toolbar (Safari does not focus buttons at all)
    bar.addEventListener('mousedown', (e) => e.preventDefault())

    const body = el('div', 'td-body')
    const code = el('div', 'td-code codemirror-host')
    code.appendChild(this.cm.dom)
    this.cm.dom.addEventListener('keydown', this.onCodeKeydown, true)
    const pane = el('div', 'td-preview')
    const preview = el('div', 'td-preview-content')
    const error = el('div', 'td-error')
    pane.append(preview, error)
    pane.addEventListener('mousedown', (e) => {
      if (this.editing) e.preventDefault() // clicking the preview must not end editing
    })
    pane.addEventListener('click', () => {
      if (!this.editing && this.view.editable) this.setEditing(true, true)
    })
    body.append(code, pane)
    this.dom.append(bar, body)

    this.ui = { switches, code, preview, error, toggle }
    this.renderedKey = ''
    this.applyMode()
    this.refresh(true)
  }

  private unmountUI() {
    this.cm.dom.removeEventListener('keydown', this.onCodeKeydown, true)
    this.ui = null
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = null
    this.dom.replaceChildren()
  }

  private setEditing(on: boolean, focus = false) {
    if (on && !this.view.editable) return
    if (this.editing !== on) {
      this.editing = on
      this.applyMode()
    }
    if (on && focus) requestAnimationFrame(() => this.cm?.focus())
  }

  private applyMode() {
    this.dom.classList.toggle('editing', this.editing)
    this.ui?.code.classList.toggle('hidden', !this.editing)
    if (this.ui) this.ui.toggle.textContent = this.editing ? '完成' : '编辑'
    this.showPreview()
  }

  /** Leave edit mode once focus has really left the block (not just the window). */
  private onFocusOut = () => {
    setTimeout(() => {
      if (!this.editing || !document.hasFocus()) return
      if (this.dom.contains(document.activeElement)) return
      this.setEditing(false)
    })
  }

  /** Esc: stop editing and put the caret right below the block. */
  private onCodeKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    // let CodeMirror close its own popups first
    if (this.cm.dom.querySelector('.cm-tooltip-autocomplete, .cm-search')) return
    e.preventDefault()
    e.stopPropagation()
    this.setEditing(false)
    const pos = this.getPos()
    if (pos == null) return
    // the caret goes into the paragraph below; another code block would just open up again
    const { state } = this.view
    const after = pos + this.node.nodeSize
    const tr = state.tr
    if (state.doc.resolve(after).nodeAfter?.type.name !== 'paragraph') tr.insert(after, state.schema.nodes.paragraph.create())
    this.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
    this.view.focus()
  }

  private deleteBlock() {
    const pos = this.getPos()
    if (pos == null || !this.view.editable) return
    this.view.dispatch(deleteBlockAt(this.view.state.tr, pos, this.node, true).scrollIntoView())
    this.view.focus()
  }

  private switchLang(lang: TextDiagramLang) {
    if (lang === this.lang || !this.view.editable) return
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    const tr = state.tr.setNodeAttribute(pos, 'language', lang)
    // an untouched starter example is swapped for the other language's one
    const text = this.node.textContent.trim()
    if (text === DIAGRAM_TEMPLATES[this.lang].trim()) {
      tr.replaceWith(pos + 1, pos + 1 + this.node.content.size, state.schema.text(DIAGRAM_TEMPLATES[lang]))
    }
    this.view.dispatch(tr)
  }

  /** Re-render the preview when language or code changed (debounced while typing). */
  private refresh(immediate = false) {
    const ui = this.ui
    if (!ui) return
    for (const b of ui.switches) {
      const on = b.dataset.lang === this.lang
      b.classList.toggle('active', on)
      b.setAttribute('aria-checked', String(on))
    }
    const key = this.lang + '\n' + this.node.textContent
    if (key === this.renderedKey) return
    this.renderedKey = key
    if (this.renderTimer) clearTimeout(this.renderTimer)
    const run = () => {
      this.renderTimer = null
      this.render()
    }
    if (immediate) run()
    else this.renderTimer = setTimeout(run, RENDER_DELAY)
  }

  private render() {
    const lang = this.lang
    const code = this.node.textContent
    const seq = ++this.renderSeq
    if (!code.trim()) {
      this.lastHtml = ''
      this.showPreview()
      return
    }
    renderTextDiagram(lang, code).then(
      (html) => {
        if (seq !== this.renderSeq) return
        this.lastHtml = sanitize(html)
        this.showPreview()
      },
      (e: Error & { title?: string }) => {
        if (seq !== this.renderSeq) return
        this.showPreview(e.title ?? `${labelOf(lang)} 语法错误`, e.message)
      },
    )
  }

  private showPreview(errorTitle?: string, errorMsg?: string) {
    const ui = this.ui
    if (!ui) return
    const empty = !this.node.textContent.trim()
    if (empty) {
      ui.preview.innerHTML = ''
      ui.preview.appendChild(
        el(
          'div',
          'ink-preview-hint',
          this.editing ? `在左侧输入 ${labelOf(this.lang)} 代码` : `空白文本绘图 · 点击编辑`,
        ),
      )
    } else if (this.lastHtml) {
      if (ui.preview.innerHTML !== this.lastHtml) ui.preview.innerHTML = this.lastHtml
    } else if (!errorTitle) {
      ui.preview.innerHTML = '<div class="ink-preview-hint">渲染中…</div>'
    } else {
      ui.preview.innerHTML = ''
    }
    ui.error.replaceChildren()
    if (errorTitle && !empty) {
      ui.error.append(el('strong', '', errorTitle), el('pre', '', errorMsg))
    }
    ui.error.hidden = !errorTitle || empty
    this.dom.classList.toggle('has-error', !!errorTitle && !empty)
  }

  update(node: PMNode) {
    // turning into an ordinary code block (or another node) needs the regular view
    if (node.type !== this.node.type || !textDiagramLang(node.attrs.language)) return false
    const ok = super.update(node)
    if (!this.view.editable && this.editing) this.setEditing(false)
    this.refresh()
    return ok
  }

  // The cursor moving into the block (arrow keys) opens the code editor.
  setSelection(anchor: number, head: number) {
    this.setEditing(true)
    super.setSelection(anchor, head)
  }

  // A node selection (Backspace from the paragraph below, the block handle, ...) only
  // highlights the block and keeps focus in the document, so Backspace / Delete removes it.
  // The base class would focus CodeMirror here and swallow those keys.
  selectNode() {
    this.selected.value = true
  }

  destroy() {
    this.dom.removeEventListener('focusout', this.onFocusOut)
    if (this.renderTimer) clearTimeout(this.renderTimer)
    super.destroy()
  }
}

/**
 * Takes over code_block node views: text diagram languages get TextDiagramView, everything
 * else goes to Crepe's stock view. Use after Crepe's CodeMirror feature has been added.
 */
export const textDiagramView = $viewAsync(codeBlockSchema.node, async (ctx) => {
  await ctx.wait(SchemaReady)
  // let the stock code-block view (registered synchronously after SchemaReady) land first
  await new Promise((r) => setTimeout(r))
  const stock = ctx.get(nodeViewCtx).find(([id]) => id === codeBlockSchema.node.id)?.[1]
  const config = ctx.use(codeBlockConfig.key)
  const watch = (w: (c: any) => unknown) => config.on(w)
  if (!stock) console.warn('textDiagramView: stock code-block view not found; code blocks lose highlighting')
  const factory: NodeViewConstructor = (node, view, getPos, decorations, innerDecorations) => {
    if (textDiagramLang(node.attrs.language)) return new TextDiagramView(node, view, getPos, config.get(), watch) as any
    const nv = stock
      ? stock(node, view, getPos, decorations, innerDecorations)
      : (new CodeMirrorBlock(node, view, getPos, noLanguages as any, config.get(), watch) as any)
    // a selected preview block (drawing, table embed, formula) keeps the keys in the
    // document so Backspace / Delete remove the block (see previewBlocks.ts); the stock
    // view would focus its hidden CodeMirror instead
    const selectNode = nv.selectNode?.bind(nv)
    nv.selectNode = () => {
      if (isPreviewBlock((nv as any).node)) (nv as any).selected.value = true
      else selectNode?.()
    }
    // the language is typed into / picked from an input instead of Crepe's button + popup
    const syncLang = withLangInput(nv as any, view)
    // a code block switched to mermaid / dot is rebuilt as a text diagram
    const update = nv.update?.bind(nv)
    nv.update = (n: PMNode, ...rest: any[]) => {
      if (textDiagramLang(n.attrs.language)) return false
      const ok = update?.(n, ...(rest as [any, any])) ?? false
      if (ok) syncLang()
      return ok
    }
    return nv
  }
  return factory
})
