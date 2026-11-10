// Rendering of "diagram" code blocks (mermaid / graphviz / excalidraw / drawio / mindmap) into previews.
// Heavy libraries are loaded lazily the first time they are needed.

export interface DrawingRef {
  scene?: string
  svg?: string
  new?: string
}

/** Drawing blocks: the block body is JSON pointing at the source + SVG preview attachments. */
export type DrawingKind = 'excalidraw' | 'drawio' | 'mindmap'

export const DRAWINGS: Record<DrawingKind, { label: string; empty: string; svgName: string; sceneName: string }> = {
  excalidraw: { label: '画板', empty: '空白画板 · 点击开始绘制', svgName: 'drawing.svg', sceneName: 'scene.excalidraw' },
  drawio: { label: '流程图', empty: '空白流程图 · 点击用 draw.io 绘制', svgName: 'diagram.svg', sceneName: 'diagram.drawio' },
  mindmap: { label: '思维导图', empty: '空白思维导图 · 点击开始编辑', svgName: 'mindmap.svg', sceneName: 'mindmap.json' },
}

export const isDrawingKind = (k: string): k is DrawingKind => k in DRAWINGS

export const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/** Decode a data: URL (base64 or percent-encoded) into UTF-8 text. */
export function dataURLToText(url: string): string {
  const comma = url.indexOf(',')
  const meta = url.slice(0, comma)
  const body = url.slice(comma + 1)
  if (/;base64$/i.test(meta)) {
    const bin = atob(body)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  return decodeURIComponent(body)
}

export const DIAGRAM_TEMPLATES: Record<string, string> = {
  mermaid: 'graph TD\n  A[开始] --> B{条件判断}\n  B -->|是| C[处理 A]\n  B -->|否| D[处理 B]\n  C --> E[结束]\n  D --> E',
  dot: 'digraph G {\n  rankdir=LR\n  node [shape=box, style=rounded]\n  浏览器 -> 服务端 -> 数据库\n  服务端 -> 文件存储\n}',
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const errorBox = (title: string, msg: string) =>
  `<div class="ink-preview-error"><strong>${escapeHtml(title)}</strong><pre>${escapeHtml(msg)}</pre></div>`

const hint = (text: string) => `<div class="ink-preview-hint">${escapeHtml(text)}</div>`

// ---------- mermaid ----------
let mermaidP: Promise<typeof import('mermaid').default> | null = null
function getMermaid() {
  mermaidP ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: prefersDark() ? 'dark' : 'default',
      fontFamily: 'inherit',
    })
    return m.default
  })
  return mermaidP
}

let seq = 0
const cache = new Map<string, string>()
function remember(key: string, value: string) {
  cache.set(key, value)
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return value
}

async function renderMermaid(code: string): Promise<string> {
  const key = 'mermaid:' + (prefersDark() ? 'dark:' : '') + code
  if (cache.has(key)) return cache.get(key)!
  const mermaid = await getMermaid()
  const id = `ink-mmd-${++seq}`
  try {
    const { svg } = await mermaid.render(id, code)
    return remember(key, `<div class="ink-diagram">${svg}</div>`)
  } catch (e: any) {
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
    return errorBox('Mermaid 语法错误', String(e?.message ?? e))
  }
}

// ---------- graphviz ----------
let vizP: Promise<any> | null = null
function getViz() {
  vizP ??= import('@viz-js/viz').then((m) => m.instance())
  return vizP
}

async function renderDot(code: string): Promise<string> {
  const key = 'dot:' + code
  if (cache.has(key)) return cache.get(key)!
  const viz = await getViz()
  try {
    const svg: string = viz.renderString(code, { format: 'svg', engine: 'dot' })
    return remember(key, `<div class="ink-diagram dot">${svg.replace(/^<\?xml[^>]*>\s*(<!DOCTYPE[^>]*>)?/, '')}</div>`)
  } catch (e: any) {
    return errorBox('Graphviz 语法错误', String(e?.message ?? e))
  }
}

// ---------- excalidraw ----------
export function parseDrawing(content: string): DrawingRef {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function drawingPreview(content: string, kind: DrawingKind): HTMLElement {
  const ref = parseDrawing(content)
  const meta = DRAWINGS[kind]
  const wrap = document.createElement('div')
  wrap.className = 'ink-drawing ink-drawing-' + kind
  wrap.setAttribute('data-ink-drawing', content)
  wrap.setAttribute('data-ink-kind', kind)
  if (ref.svg) {
    const img = document.createElement('img')
    img.src = `/files/${ref.svg}/${meta.svgName}`
    img.alt = meta.label
    img.loading = 'lazy'
    wrap.appendChild(img)
  } else {
    const empty = document.createElement('div')
    empty.className = 'ink-drawing-empty'
    empty.textContent = meta.empty
    wrap.appendChild(empty)
  }
  return wrap
}

export function renderPreview(
  language: string,
  content: string,
  apply: (value: null | string | HTMLElement) => void,
): void | null | string | HTMLElement {
  const lang = (language || '').toLowerCase()
  switch (lang) {
    case 'mermaid':
      if (!content.trim()) return hint('空白 Mermaid 图 · 点击右上角「编辑」输入代码')
      renderMermaid(content).then(apply)
      return undefined
    case 'dot':
    case 'graphviz':
      if (!content.trim()) return hint('空白 Graphviz 图 · 点击右上角「编辑」输入 DOT 代码')
      renderDot(content).then(apply)
      return undefined
    case 'excalidraw':
    case 'drawio':
    case 'mindmap':
      return drawingPreview(content, lang)
  }
  return null
}
