import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Nearest scrolling ancestor of `el`, or null for the document itself. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

/**
 * Windowing for long lists of equally tall rows (directory trees with thousands of
 * entries): only the rows near the visible part of the scroll container are rendered,
 * the rest is replaced by two spacers. The row height is measured from a rendered row
 * (it differs between desktop and touch layouts), each row must carry `data-row`.
 */
export function useWindowed<T extends HTMLElement>(count: number, estimate: number, overscan = 12) {
  // callback ref: the list may mount later than the component (and its scroller with it)
  const [list, listRef] = useState<T | null>(null)
  const [rowH, setRowH] = useState(estimate)
  const [range, setRange] = useState<[number, number]>([0, Math.min(count, 60)])
  const rowHRef = useRef(rowH)
  rowHRef.current = rowH
  const countRef = useRef(count)
  countRef.current = count

  const update = useCallback(() => {
    if (!list) return
    const scroller = scrollParent(list)
    const top = list.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0)
    const viewH = scroller ? scroller.clientHeight : window.innerHeight
    const h = rowHRef.current
    const n = countRef.current
    const start = Math.max(0, Math.min(n, Math.floor(-top / h) - overscan))
    const end = Math.max(start, Math.min(n, Math.ceil((viewH - top) / h) + overscan))
    setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]))
  }, [list, overscan])

  useEffect(() => {
    if (!list) return
    const scroller = scrollParent(list)
    const target: HTMLElement | Window = scroller ?? window
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [list, update])

  useLayoutEffect(update, [update, count, rowH])

  // measure the real row pitch (height + vertical margins) from the first rendered row
  useLayoutEffect(() => {
    const row = list?.querySelector<HTMLElement>('[data-row]')
    if (!row) return
    const cs = getComputedStyle(row)
    const h = row.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)
    if (h > 0 && Math.abs(h - rowHRef.current) > 0.5) setRowH(h)
  })

  const [start, end] = [Math.min(range[0], count), Math.min(range[1], count)]
  return {
    listRef,
    start,
    end,
    /** heights of the spacers before and after the rendered rows */
    before: start * rowH,
    after: (count - end) * rowH,
  }
}
