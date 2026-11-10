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

/** Right-hand outline (desktop) / bottom drawer (mobile) for the document in `.doc-main`. */
export default function Outline({ headings, open, onClose }: { headings: Heading[]; open: boolean; onClose: () => void }) {
  const minLevel = useMemo(() => Math.min(6, ...headings.map((h) => h.level)), [headings])
  if (headings.length === 0) return null
  const jumpTo = (h: Heading) => {
    const els = document.querySelectorAll('.doc-main .ink-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6)')
    els[h.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
