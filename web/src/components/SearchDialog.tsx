import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, formatTime, type SearchHit } from '../api'
import { untitled, useStore } from '../store'
import { IconDoc, IconSearch } from './icons'

function Snippet({ text }: { text: string }) {
  // \x01 … \x02 mark highlighted ranges (from FTS5 snippet())
  const parts = text.replace(/\s+/g, ' ').split(/(\x01[^\x02]*\x02)/)
  return (
    <>
      {parts.map((p, i) => (p.startsWith('\x01') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </>
  )
}

export default function SearchDialog() {
  const { searchOpen, setSearchOpen } = useStore()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [recent, setRecent] = useState<SearchHit[]>([])
  const [sel, setSel] = useState(0)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  useEffect(() => {
    if (!searchOpen) return
    setSel(0)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    api.recent().then((r) => setRecent(r.slice(0, 8).map((d) => ({ ...d, snippet: '' })))).catch(() => {})
  }, [searchOpen])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    setLoading(true)
    const t = setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          setHits(r)
          setSel(0)
        })
        .catch(() => setHits([]))
        .finally(() => setLoading(false))
    }, 180)
    return () => clearTimeout(t)
  }, [q])

  if (!searchOpen) return null
  const list = q.trim() ? hits : recent
  const go = (h: SearchHit) => {
    setSearchOpen(false)
    navigate(`/r/${h.repo_id}/d/${h.id}`)
  }

  return (
    <div className="modal-backdrop search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSearchOpen(false)}>
      <div className="search-panel">
        <div className="search-input">
          <IconSearch />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            placeholder="搜索文档标题和内容…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchOpen(false)
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, list.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter' && list[sel] && !e.nativeEvent.isComposing) go(list[sel])
            }}
          />
          <button className="btn ghost mobile-only" onClick={() => setSearchOpen(false)}>
            取消
          </button>
        </div>
        <div className="search-results">
          {!q.trim() && recent.length > 0 && <div className="search-group">最近编辑</div>}
          {list.map((h, i) => (
            <button key={h.id} className={'search-hit' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <IconDoc className="hit-icon" />
              <div className="hit-main">
                <div className="hit-title">{untitled(h.title)}</div>
                {h.snippet && (
                  <div className="hit-snippet">
                    <Snippet text={h.snippet} />
                  </div>
                )}
              </div>
              <div className="hit-meta">
                <span>{h.repo_name}</span>
                <span>{formatTime(h.updated_at)}</span>
              </div>
            </button>
          ))}
          {q.trim() && !loading && hits.length === 0 && <div className="search-empty">没有找到相关文档</div>}
        </div>
      </div>
    </div>
  )
}
