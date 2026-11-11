import { useMemo } from 'react'
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
    <aside
      className={cn(
        // wide screens: a sticky column beside the text; narrower: a drawer from the right
        'max-xl:fixed max-xl:inset-0 max-xl:z-40 max-xl:bg-scrim',
        open ? 'max-xl:block max-xl:animate-fade' : 'max-xl:hidden',
        'xl:sticky xl:top-(--header-h) xl:max-h-[calc(100dvh-var(--header-h)-var(--statusbar-h))] xl:w-60 xl:shrink-0 xl:overflow-y-auto xl:pt-14 xl:pr-5 xl:pb-8',
      )}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:w-[min(300px,82vw)] max-xl:animate-slide-right max-xl:overflow-y-auto max-xl:bg-overlay max-xl:px-3 max-xl:pt-[calc(20px+var(--safe-t))] max-xl:pb-[calc(20px+var(--safe-b))] max-xl:shadow-modal">
        <div className="mb-2 flex items-center gap-1.5 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">大纲</div>
        <div className="xl:border-l xl:border-line-subtle">
          {headings.map((h) => (
            <button
              key={h.index}
              className={cn(
                'relative block w-full truncate py-1 pr-3 text-left text-[12.5px] leading-relaxed text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink',
                'max-xl:rounded-md max-xl:py-2 max-xl:hover:bg-hover',
                'xl:before:absolute xl:before:inset-y-1.5 xl:before:-left-px xl:before:w-0.5 xl:before:rounded-full xl:before:bg-transparent xl:before:transition-colors xl:hover:before:bg-accent',
                h.level === minLevel && 'font-medium text-ink-2',
              )}
              style={{ paddingLeft: 12 + (h.level - minLevel) * 13 }}
              onClick={() => jumpTo(h)}
            >
              {h.text}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
