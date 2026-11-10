// Rendering of "diagram" code blocks (mermaid / graphviz / excalidraw) into previews.
// Heavy libraries are loaded lazily the first time they are needed.

export interface DrawingRef {
  scene?: string
  svg?: string
  new?: string
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
      theme: 'default',
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
  const key = 'mermaid:' + code
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
    return remember(key, `<div class="ink-diagram">${svg.replace(/^<\?xml[^>]*>\s*(<!DOCTYPE[^>]*>)?/, '')}</div>`)
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

function drawingPreview(content: string): HTMLElement {
  const ref = parseDrawing(content)
  const wrap = document.createElement('div')
  wrap.className = 'ink-drawing'
  wrap.setAttribute('data-ink-drawing', content)
  if (ref.svg) {
    const img = document.createElement('img')
    img.src = `/files/${ref.svg}/drawing.svg`
    img.alt = '画板'
    img.setAttribute('data-ink-drawing', content)
    wrap.appendChild(img)
  } else {
    const empty = document.createElement('div')
    empty.className = 'ink-drawing-empty'
    empty.setAttribute('data-ink-drawing', content)
    empty.textContent = '空白画板 · 点击开始绘制'
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
      return drawingPreview(content)
  }
  return null
}
