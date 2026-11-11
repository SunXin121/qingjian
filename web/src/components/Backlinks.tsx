import { useEffect, useState, type MouseEvent } from 'react'
import { api, formatTime, type Backlink } from '../api'
import { IconDoc, IconLink } from './icons'
import { cn } from './ui'

/** Documents linking to a node (双链); empty while loading or on errors. */
export function useBacklinks(nodeId: string): Backlink[] {
  const [list, setList] = useState<Backlink[]>([])
  useEffect(() => {
    let alive = true
    setList([])
    api.backlinks(nodeId).then(
      (r) => alive && setList(r),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [nodeId])
  return list
}

/**
 * The linking documents with the text around each link. Opening goes through the app's
 * `qj-nav` event, so the list also works in popovers rendered outside the router.
 */
export function BacklinkList({ list, repoId, onOpen }: { list: Backlink[]; repoId: string; onOpen?: () => void }) {
  const open = (e: MouseEvent, path: string) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    onOpen?.()
    window.dispatchEvent(new CustomEvent('qj-nav', { detail: path }))
  }
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((b) => {
        const path = `/r/${b.repo_id}/d/${b.id}`
        return (
          <a
            key={b.id}
            className="group block rounded-lg border border-line-subtle bg-surface px-3.5 py-2.5 transition-[border-color,box-shadow] duration-(--dur-fast) hover:border-line hover:shadow-card"
            href={path}
            onClick={(e) => open(e, path)}
          >
            <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink">
              <IconDoc width={14} height={14} className="shrink-0 text-ink-3 group-hover:text-accent" />
              <span className="min-w-0 flex-1 truncate group-hover:text-accent">{b.title.trim() || '无标题文档'}</span>
              {b.repo_id !== repoId && <span className="max-w-28 shrink-0 truncate rounded-full bg-inset px-2 py-0.5 text-[11px] font-normal text-ink-3">{b.repo_name}</span>}
              <span className="tabular shrink-0 text-[11px] font-normal text-ink-4">{formatTime(b.updated_at)}</span>
            </div>
            {b.snippet && <div className="mt-1 line-clamp-2 pl-[22px] text-[12px] leading-relaxed text-ink-3">{b.snippet}</div>}
          </a>
        )
      })}
    </div>
  )
}

/** Backlinks listed below a document. */
export default function Backlinks({ nodeId, repoId }: { nodeId: string; repoId: string }) {
  const list = useBacklinks(nodeId)
  if (!list.length) return null
  return (
    <section className={cn('mt-14 border-t border-line-subtle pt-6')}>
      <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        <IconLink width={14} height={14} className="text-ink-3" />
        <span>反向链接</span>
        <span className="tabular rounded-full bg-active px-1.5 py-px text-[11px] font-medium text-ink-3">{list.length}</span>
      </div>
      <BacklinkList list={list} repoId={repoId} />
    </section>
  )
}
