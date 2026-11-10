import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, formatTime, type Backlink } from '../api'
import { IconDoc, IconLink } from './icons'

/** Documents linking to this one (双链), listed below the document. */
export default function Backlinks({ nodeId, repoId }: { nodeId: string; repoId: string }) {
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
  if (!list.length) return null
  return (
    <section className="backlinks">
      <div className="backlinks-head">
        <IconLink width={15} height={15} />
        <span>反向链接</span>
        <span className="backlinks-count">{list.length}</span>
      </div>
      <div className="backlinks-list">
        {list.map((b) => (
          <Link key={b.id} className="backlink" to={`/r/${b.repo_id}/d/${b.id}`}>
            <div className="backlink-title">
              <IconDoc width={14} height={14} />
              <span className="ellipsis">{b.title.trim() || '无标题文档'}</span>
              {b.repo_id !== repoId && <span className="backlink-repo ellipsis">{b.repo_name}</span>}
              <span className="spacer" />
              <span className="backlink-time">{formatTime(b.updated_at)}</span>
            </div>
            {b.snippet && <div className="backlink-snippet">{b.snippet}</div>}
          </Link>
        ))}
      </div>
    </section>
  )
}
