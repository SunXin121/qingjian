// Sizes of things that are only known once they have loaded or rendered: images (their
// natural size) and text diagrams (their rendered height). Remembered across visits so the
// next time the space is reserved before the first paint and the page does not jump when
// they arrive. Kept in localStorage; a missing or blocked storage only loses the memory.

const KEY = 'qj-sizes'
const MAX = 2000

type Size = [number, number]
let sizes: Map<string, Size> | null = null
let saveTimer = 0

function all(): Map<string, Size> {
  if (!sizes) {
    sizes = new Map()
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
      if (Array.isArray(raw)) for (const [k, w, h] of raw) if (typeof k === 'string' && w > 0 && h > 0) sizes.set(k, [w, h])
    } catch {
      // unreadable or blocked: start empty
    }
  }
  return sizes
}

function save() {
  saveTimer = 0
  try {
    localStorage.setItem(KEY, JSON.stringify([...all()].map(([k, [w, h]]) => [k, w, h])))
  } catch {
    // full or blocked: keep it in memory only
  }
}

function get(key: string): Size | undefined {
  return all().get(key)
}

function set(key: string, w: number, h: number) {
  const m = all()
  const old = m.get(key)
  if (old && old[0] === w && old[1] === h) return
  // most recent last: the oldest entries are dropped first
  m.delete(key)
  m.set(key, [w, h])
  while (m.size > MAX) m.delete(m.keys().next().value!)
  if (!saveTimer) saveTimer = window.setTimeout(save, 1000)
}

/** Remembered natural size of an image URL (data: URLs are never remembered). */
export const imageSize = (src: string) => get('i:' + src)

export function rememberImageSize(img: HTMLImageElement) {
  const src = img.getAttribute('src')
  if (!src || src.startsWith('data:') || !img.naturalWidth || !img.naturalHeight) return
  set('i:' + src, img.naturalWidth, img.naturalHeight)
}

/** Short stable key of a long text (FNV-1a, two seeds). */
function hash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36)
}

/** Remembered rendered height of a text diagram, and the width it was rendered at. */
export function diagramSize(key: string): { width: number; height: number } | undefined {
  const s = get('d:' + hash(key))
  return s && { width: s[0], height: s[1] }
}

export function rememberDiagramSize(key: string, width: number, height: number) {
  if (width > 0 && height > 0) set('d:' + hash(key), Math.round(width), Math.round(height))
}
