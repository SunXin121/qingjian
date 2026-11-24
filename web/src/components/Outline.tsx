import { useEffect, useMemo, useState } from 'react'
import { emitAppEvent } from '../events'
import { cn } from './ui'

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

/** Right-hand outline (desktop) / drawer (mobile) with scroll-spy active section tracking. */
export default function Outline({ headings, open, onClose }: { headings: Heading[]; open: boolean; onClose: () => void }) {
  const minLevel = useMemo(() => Math.min(6, ...headings.map((h) => h.level)), [headings])
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    if (headings.length === 0) return
    let raf = 0
    const updateActive = () => {
      raf = 0
      const els = document.querySelectorAll<HTMLElement>('.doc-main .ink-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6)')
      if (!els.length) return
      const threshold = 96
      let current = 0
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top <= threshold) current = i
        else break
      }
      setActiveIdx(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(updateActive)
    }
    updateActive()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [headings])

  if (headings.length === 0) return null

  const jumpTo = (h: Heading) => {
    emitAppEvent('qj-editor-flush')
    const els = document.querySelectorAll('.doc-main .ink-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6)')
    const el = els[h.index] as HTMLElement | undefined
    setActiveIdx(h.index)
    if (el) scrollToHeading(el)
    onClose()
  }

  return (
    <aside
      aria-label="文档大纲"
      className={cn(
        'max-xl:fixed max-xl:inset-0 max-xl:z-40 max-xl:bg-scrim',
        open ? 'max-xl:block max-xl:animate-fade' : 'max-xl:hidden',
        'xl:sticky xl:top-(--header-h) xl:max-h-[calc(100dvh-var(--header-h)-var(--statusbar-h))] xl:w-60 xl:shrink-0 xl:overflow-y-auto xl:pt-14 xl:pr-5 xl:pb-8',
      )}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <nav
        aria-label="章节目录"
        className="max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:w-[min(300px,82vw)] max-xl:animate-slide-right max-xl:overflow-y-auto max-xl:bg-overlay max-xl:px-3 max-xl:pt-[calc(20px+var(--safe-t))] max-xl:pb-[calc(20px+var(--safe-b))] max-xl:shadow-modal"
      >
        <div className="mb-2.5 flex items-center justify-between px-3 text-[11.5px] font-semibold tracking-wider text-ink-4 uppercase">
          <span>大纲</span>
          <span className="tabular font-normal">{headings.length}</span>
        </div>
        <div className="xl:border-l xl:border-line-subtle">
          {headings.map((h) => {
            const active = h.index === activeIdx
            return (
              <button
                key={h.index}
                type="button"
                aria-current={active ? 'location' : undefined}
                className={cn(
                  'relative block w-full truncate py-1 pr-3 text-left text-[12.5px] leading-relaxed transition-colors duration-(--dur-fast)',
                  'max-xl:rounded-md max-xl:py-2 max-xl:hover:bg-hover',
                  'xl:before:absolute xl:before:inset-y-1 xl:before:-left-px xl:before:w-[2px] xl:before:rounded-full xl:before:transition-colors',
                  active
                    ? 'font-medium text-accent max-xl:bg-accent-softer xl:before:bg-accent'
                    : cn('text-ink-3 hover:text-ink xl:before:bg-transparent xl:hover:before:bg-line-strong', h.level === minLevel && 'font-medium text-ink-2'),
                )}
                style={{ paddingLeft: 12 + (h.level - minLevel) * 12 }}
                onClick={() => jumpTo(h)}
              >
                {h.text}
              </button>
            )
          })}
        </div>
      </nav>
    </aside>
  )
}
