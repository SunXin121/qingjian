import { useEffect, useState, type MouseEvent } from 'react'
import { api, formatTime, type Backlink } from '../api'
import { IconDoc, IconLink } from './icons'

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
    <div className="backlinks-list">
      {list.map((b) => {
        const path = `/r/${b.repo_id}/d/${b.id}`
        return (
          <a key={b.id} className="backlink" href={path} onClick={(e) => open(e, path)}>
            <div className="backlink-title">
              <IconDoc width={14} height={14} />
              <span className="ellipsis">{b.title.trim() || '无标题文档'}</span>
              {b.repo_id !== repoId && <span className="backlink-repo ellipsis">{b.repo_name}</span>}
              <span className="spacer" />
              <span className="backlink-time">{formatTime(b.updated_at)}</span>
            </div>
            {b.snippet && <div className="backlink-snippet">{b.snippet}</div>}
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
    <section className="backlinks">
      <div className="backlinks-head">
        <IconLink width={15} height={15} />
        <span>反向链接</span>
        <span className="backlinks-count">{list.length}</span>
      </div>
      <BacklinkList list={list} repoId={repoId} />
    </section>
  )
}
