// Rendering of diagram code blocks into previews: text diagrams (mermaid / graphviz, used by
// textDiagram.ts) and drawing blocks (excalidraw / drawio / mindmap, via Crepe's renderPreview).
// Heavy libraries are loaded lazily the first time they are needed.

import { renderPlantUML } from '../api'
import { isDark } from '../theme'
import { imageSize, rememberImageSize } from './sizeMemo'

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

/** Whether the page is currently shown in the dark theme (system or chosen in settings). */
export const prefersDark = isDark

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
  plantuml: '@startuml\nactor 用户\n用户 -> 浏览器: 打开文档\n浏览器 -> 服务端: 请求数据\n服务端 --> 浏览器: 返回 Markdown\n浏览器 --> 用户: 渲染页面\n@enduml',
  dot: 'digraph G {\n  rankdir=LR\n  node [shape=box, style=rounded]\n  浏览器 -> 服务端 -> 数据库\n  服务端 -> 文件存储\n}',
}

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

export type TextDiagramLang = 'mermaid' | 'dot' | 'plantuml'

/** Code-block languages shown as text diagrams ("graphviz" is an alias of "dot", "puml" of "plantuml"). */
export function textDiagramLang(language: string | null | undefined): TextDiagramLang | null {
  const l = (language || '').toLowerCase()
  if (l === 'mermaid') return 'mermaid'
  if (l === 'dot' || l === 'graphviz') return 'dot'
  if (l === 'plantuml' || l === 'puml') return 'plantuml'
  return null
}

async function renderMermaid(code: string): Promise<string> {
  const mermaid = await getMermaid()
  const id = `ink-mmd-${++seq}`
  try {
    const { svg } = await mermaid.render(id, code)
    return `<div class="ink-diagram">${svg}</div>`
  } catch (e: any) {
    throw new Error(String(e?.message ?? e), { cause: e })
  } finally {
    // mermaid leaves its scratch element behind when parsing fails
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
  }
}

// ---------- graphviz ----------
let vizP: Promise<any> | null = null
function getViz() {
  vizP ??= import('@viz-js/viz').then((m) => m.instance())
  return vizP
}

async function renderDot(code: string): Promise<string> {
  const viz = await getViz()
  const result = viz.render(code, { format: 'svg', engine: 'dot' })
  if (result.status !== 'success') {
    throw new Error(result.errors.map((e: { message: string }) => e.message).join('\n') || 'syntax error')
  }
  const svg: string = result.output
  return `<div class="ink-diagram dot">${svg.replace(/^<\?xml[^>]*>\s*(<!DOCTYPE[^>]*>)?/, '')}</div>`
}

// ---------- plantuml (rendered by the server's PlantUML service) ----------
async function renderPlantUMLBlock(code: string): Promise<string> {
  let res: { svg: string; error?: boolean }
  try {
    res = await renderPlantUML(code)
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? String(e)), { title: 'PlantUML 渲染失败' })
  }
  const { svg, error } = res
  // syntax errors come back as a picture of the error: pass its text on as the message
  if (error) {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const lines = [...doc.querySelectorAll('text')].map((t) => t.textContent?.trim()).filter(Boolean)
    throw new Error(lines.join('\n') || 'syntax error')
  }
  return `<div class="ink-diagram dot plantuml">${svg.replace(/^<\?xml[^>]*>\s*/, '')}</div>`
}

/** Start loading a text diagram's renderer ahead of the first diagram that needs it. */
export function warmTextDiagram(lang: TextDiagramLang) {
  if (lang === 'mermaid') getMermaid().catch(() => {})
  else if (lang === 'dot') getViz().catch(() => {})
}

/** Render a text diagram to (unsanitised) HTML; rejects with the syntax error. */
export async function renderTextDiagram(lang: TextDiagramLang, code: string): Promise<string> {
  const key = lang + ':' + (lang === 'mermaid' && prefersDark() ? 'dark:' : '') + code
  if (cache.has(key)) return cache.get(key)!
  const html = await (lang === 'mermaid' ? renderMermaid(code) : lang === 'plantuml' ? renderPlantUMLBlock(code) : renderDot(code))
  return remember(key, html)
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
    const src = `/files/${ref.svg}/${meta.svgName}`
    img.src = src
    img.alt = meta.label
    img.loading = 'lazy'
    // reserve the picture's space before it loads (CSS keeps it within the column)
    const size = imageSize(src)
    if (size) [img.width, img.height] = size
    img.addEventListener('load', () => rememberImageSize(img), { once: true })
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
    case 'excalidraw':
    case 'drawio':
    case 'mindmap':
      return drawingPreview(content, lang)
    case 'table':
      import('../table/embed').then((m) => {
        const r = m.renderTableEmbed(content, apply)
        if (r !== undefined) apply(r)
      })
      return undefined
  }
  return null
}
