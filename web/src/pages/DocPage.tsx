import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, formatTime, type Doc } from '../api'
import { confirmDialog, openMenu, toast } from '../components/dialog'
import { IconHistory, IconList, IconMore } from '../components/icons'
import PageHeader from '../components/PageHeader'
import VersionsPanel from '../components/VersionsPanel'
import Editor from '../editor/Editor'
import { useStore } from '../store'

type Status = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

interface Heading {
  level: number
  text: string
  index: number
}

function parseHeadings(md: string): Heading[] {
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

export default function DocPage() {
  const { repoId, docId } = useParams() as { repoId: string; docId: string }
  const { patchNode, repos, loadTree } = useStore()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatusState] = useState<Status>('saved')
  const statusRef = useRef<Status>('saved')
  const setStatus = useCallback((s: Status) => {
    statusRef.current = s
    setStatusState(s)
  }, [])
  const [savedAt, setSavedAt] = useState(0)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [mountKey, setMountKey] = useState(0)

  const md = useRef('')
  const titleRef = useRef('')
  const base = useRef(0)
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<number>(0)
  const titleEl = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const d = await api.doc(docId)
      setDoc(d)
      setTitle(d.title)
      titleRef.current = d.title
      md.current = d.markdown
      base.current = d.content_updated_at
      dirty.current = false
      setStatus('saved')
      setSavedAt(d.content_updated_at)
      setHeadings(parseHeadings(d.markdown))
      setMountKey((k) => k + 1)
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 404 ? '文档不存在或已被删除' : e.message)
    }
  }, [docId, setStatus])

  useEffect(() => {
    setDoc(null)
    setVersionsOpen(false)
    load()
  }, [load])

  const save = useCallback(
    async (opts: { force?: boolean; snapshot?: boolean } = {}) => {
      if (saving.current) await saving.current
      if (!dirty.current && !opts.snapshot) return
      clearTimeout(timer.current)
      dirty.current = false
      setStatus('saving')
      const body = { markdown: md.current, title: titleRef.current, base_updated_at: base.current, ...opts }
      const p = api
        .saveDoc(docId, body)
        .then((r) => {
          base.current = r.updated_at
          setSavedAt(r.updated_at)
          patchNode(docId, { title: r.title, updated_at: r.updated_at })
          setStatus(dirty.current ? 'dirty' : 'saved')
        })
        .catch((e) => {
          dirty.current = true
          if (e instanceof ApiError && e.status === 409) setStatus('conflict')
          else {
            setStatus('error')
            timer.current = window.setTimeout(() => save(), 5000)
          }
        })
        .finally(() => {
          saving.current = null
        })
      saving.current = p
      await p
    },
    [docId, patchNode, setStatus],
  )

  const schedule = useCallback(() => {
    dirty.current = true
    if (statusRef.current === 'conflict') return
    setStatus('dirty')
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (statusRef.current !== 'conflict') save()
    }, 1000)
  }, [save, setStatus])

  // Ctrl/Cmd+S, unload guard, flush on leave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save({ snapshot: true }).then(() => toast('已保存'))
      }
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      clearTimeout(timer.current)
      if (dirty.current) save()
    }
  }, [save])

  useEffect(() => {
    const el = titleEl.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }, [title, doc])

  const headingsTimer = useRef<number>(0)
  const onChange = useCallback(
    (m: string) => {
      md.current = m
      schedule()
      clearTimeout(headingsTimer.current)
      headingsTimer.current = window.setTimeout(() => setHeadings(parseHeadings(m)), 400)
    },
    [schedule],
  )

  const jumpTo = (h: Heading) => {
    const els = document.querySelectorAll('.doc-main .ink-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6)')
    els[h.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setOutlineOpen(false)
  }

  const minLevel = useMemo(() => Math.min(6, ...headings.map((h) => h.level)), [headings])
  const repo = repos.find((r) => r.id === repoId)

  const more = (el: HTMLElement) =>
    openMenu(el, [
      { label: '导出 Markdown', onClick: () => (location.href = `/api/docs/${docId}/export`) },
      { label: '保存版本快照', onClick: () => save({ snapshot: true }).then(() => toast('已保存快照')) },
      {
        label: '删除文档',
        danger: true,
        onClick: async () => {
          if (!(await confirmDialog('确定删除这篇文档及其子文档吗？可在回收站中恢复。', { danger: true, okText: '删除' }))) return
          dirty.current = false
          await api.deleteNode(docId)
          await loadTree(repoId)
          navigate(`/r/${repoId}`)
        },
      },
    ])

  if (error) {
    return (
      <div className="page">
        <PageHeader />
        <div className="empty-state">{error}</div>
      </div>
    )
  }
  if (!doc) return <div className="page"><PageHeader /><div className="ink-loading">加载中…</div></div>

  const statusText: Record<Status, string> = {
    saved: savedAt ? `已保存 · ${formatTime(savedAt)}` : '已保存',
    dirty: '编辑中…',
    saving: '保存中…',
    error: '保存失败，稍后重试',
    conflict: '存在冲突',
  }

  return (
    <div className="page doc-page">
      <PageHeader>
        <span className="crumb ellipsis">{repo?.name}</span>
        <span className={'save-status ' + status}>{statusText[status]}</span>
        <span className="spacer" />
        {headings.length > 0 && (
          <button className="icon-btn outline-toggle" title="大纲" onClick={() => setOutlineOpen((v) => !v)}>
            <IconList />
          </button>
        )}
        <button
          className="icon-btn"
          title="历史版本"
          onClick={async () => {
            await save()
            setVersionsOpen(true)
          }}
        >
          <IconHistory />
        </button>
        <button className="icon-btn" title="更多" onClick={(e) => more(e.currentTarget)}>
          <IconMore />
        </button>
      </PageHeader>

      {status === 'conflict' && (
        <div className="banner warn">
          <span>这篇文档在其他窗口或设备上被修改过。</span>
          <button className="btn sm" onClick={load}>
            放弃本地修改并加载最新
          </button>
          <button className="btn sm danger" onClick={() => save({ force: true })}>
            用当前内容覆盖
          </button>
        </div>
      )}

      <div className="doc-layout">
        <main className="doc-main">
          <div className="doc-body">
            <textarea
              ref={titleEl}
              className="doc-title"
              rows={1}
              value={title}
              placeholder="无标题文档"
              onChange={(e) => {
                const v = e.target.value.replace(/\n/g, '')
                setTitle(v)
                titleRef.current = v
                schedule()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  ;(document.querySelector('.doc-main .ProseMirror') as HTMLElement | null)?.focus()
                }
              }}
            />
            <Editor key={doc.id + ':' + mountKey} value={doc.markdown} onChange={onChange} />
          </div>
        </main>
        {headings.length > 0 && (
          <aside className={'outline' + (outlineOpen ? ' open' : '')} onClick={(e) => e.target === e.currentTarget && setOutlineOpen(false)}>
            <div className="outline-inner">
              <div className="outline-head">大纲</div>
              {headings.map((h) => (
                <button key={h.index} className="outline-item" style={{ paddingLeft: 8 + (h.level - minLevel) * 14 }} onClick={() => jumpTo(h)}>
                  {h.text}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>

      {versionsOpen && (
        <VersionsPanel
          docId={docId}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => {
            setVersionsOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}
