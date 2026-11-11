import { useMemo } from 'react'

export interface Heading {
  level: number
  text: string
  index: number
}

export function parseHeadings(md: string): Heading[] {
  const out: Heading[] = []
  let fence = false
  let index = 0
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`~]|\\(?=.)/g, ''), index: index++ })
  }
  return out
}

/**
 * Long documents render off-screen blocks lazily (content-visibility), so their heights
 * are estimates until they are laid out and a smooth scroll would stop short. There the
 * jump is instant and repeated until the heading stays put.
 */
function scrollToHeading(el: HTMLElement) {
  if (!el.closest('.ink-editor.large')) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  // Blocks that come near the viewport get their real height on the next frame and may
  // push the heading away again, so keep checking until it stayed in place a few frames.
  const doc = document.scrollingElement!
  let frames = 0
  let settled = 0
  const step = () => {
    const top = el.getBoundingClientRect().top
    const atEnd = doc.scrollTop + doc.clientHeight >= doc.scrollHeight - 2
    if (top < 0 || (top > window.innerHeight / 3 && !atEnd)) {
      el.scrollIntoView({ block: 'start' })
      settled = 0
    } else settled++
    if (settled < 4 && frames++ < 60) requestAnimationFrame(step)
  }
  el.scrollIntoView({ block: 'start' })
  requestAnimationFrame(step)
}

/** Right-hand outline (desktop) / bottom drawer (mobile) for the document in `.doc-main`. */
export default function Outline({ headings, open, onClose }: { headings: Heading[]; open: boolean; onClose: () => void }) {
  const minLevel = useMemo(() => Math.min(6, ...headings.map((h) => h.level)), [headings])
  if (headings.length === 0) return null
  const jumpTo = (h: Heading) => {
    // long documents are still appending their later parts right after opening
    window.dispatchEvent(new Event('qj-editor-flush'))
    const els = document.querySelectorAll('.doc-main .ink-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6)')
    const el = els[h.index] as HTMLElement | undefined
    if (el) scrollToHeading(el)
    onClose()
  }
  return (
    <aside className={'outline' + (open ? ' open' : '')} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="outline-inner">
        <div className="outline-head">大纲</div>
        {headings.map((h) => (
          <button key={h.index} className="outline-item" style={{ paddingLeft: 8 + (h.level - minLevel) * 14 }} onClick={() => jumpTo(h)}>
            {h.text}
          </button>
        ))}
      </div>
    </aside>
  )
}
