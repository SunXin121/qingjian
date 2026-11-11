import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, ApiError, formatTime, type Doc } from '../api'
import { confirmDialog, Modal, mount, openMenu, toast } from '../components/dialog'
import { IconCamera, IconChevron, IconDownload, IconHistory, IconList, IconMore, IconShare, IconTrash, RepoMark } from '../components/icons'
import Backlinks from '../components/Backlinks'
import Outline, { parseHeadings, type Heading } from '../components/Outline'
import PageHeader from '../components/PageHeader'
import { openShareDialog } from '../components/ShareDialog'
import VersionsPanel from '../components/VersionsPanel'
import Editor from '../editor/Editor'
import { useStore } from '../store'
import { onThemeChange } from '../theme'
import { exportMarkdown } from '../components/ExportDialog'

const DiffView = lazy(() => import('../components/DiffView'))

type Status = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

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
  const [stats, setStats] = useState('')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [mountKey, setMountKey] = useState(0)

  const md = useRef('')
  // serialises the editor content on demand (see Editor's onChange)
  const getMd = useRef<() => string>(() => md.current)
  /** markdown and title as last stored on the server, to skip saves that change nothing */
  const savedMd = useRef('')
  const savedTitle = useRef('')
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
      getMd.current = () => d.markdown
      savedMd.current = d.markdown
      savedTitle.current = d.title
      base.current = d.content_updated_at
      dirty.current = false
      setStatus('saved')
      setSavedAt(d.content_updated_at)
      setHeadings(parseHeadings(d.markdown))
      setStats(d.markdown)
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
      const markdown = (md.current = getMd.current())
      const title = titleRef.current
      // outline and word count follow the content at save time, so a long document is
      // only scanned once per save instead of after every pause in typing
      setHeadings(parseHeadings(markdown))
      setStats(markdown)
      if (markdown === savedMd.current && title === savedTitle.current && !opts.snapshot && !opts.force) {
        setStatus('saved')
        return
      }
      setStatus('saving')
      const body = { markdown, title, base_updated_at: base.current, ...opts }
      const p = api
        .saveDoc(docId, body)
        .then((r) => {
          savedMd.current = markdown
          savedTitle.current = title
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
    // long documents cost more to serialise and store: save them after a longer pause
    const delay = md.current.length > 200_000 ? 3000 : 1000
    timer.current = window.setTimeout(() => {
      if (statusRef.current !== 'conflict') save()
    }, delay)
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
    // A hidden tab can be frozen or discarded without any unload event (switching apps
    // on a phone), so whatever is still waiting for the autosave timer goes out now.
    const onHide = () => {
      if (document.visibilityState === 'hidden' && dirty.current && statusRef.current !== 'conflict') save()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      clearTimeout(timer.current)
      if (dirty.current) save()
    }
  }, [save])

  useEffect(() => {
    if (doc) document.title = `${title.trim() || '无标题文档'} - 青简`
  }, [title, doc])
  // the code editor's theme is fixed when the editor is created: rebuild it from the
  // saved content when the page switches between light and dark
  useEffect(
    () =>
      onThemeChange(() => {
        if (statusRef.current !== 'conflict') save().then(load)
      }),
    [save, load],
  )
  useEffect(() => {
    const el = titleEl.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }, [title, doc])

  const onChange = useCallback(
    (get: () => string) => {
      getMd.current = get
      schedule()
    },
    [schedule],
  )

  /** What the other window saved, next to what is in this editor. */
  const showConflictDiff = async () => {
    try {
      const remote = await api.doc(docId)
      const local = getMd.current()
      mount((close) => (
        <Modal title="与服务器上的版本对比" onClose={close} wide>
          <div className="modal-body conflict-diff">
            <Suspense fallback={<div className="ink-loading">加载中…</div>}>
              <DiffView oldText={remote.markdown} newText={local} oldLabel="服务器上的版本" newLabel="当前窗口的内容" />
            </Suspense>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              关闭
            </button>
          </div>
        </Modal>
      ))
    } catch (e: any) {
      toast(e.message)
    }
  }
  const repo = repos.find((r) => r.id === repoId)

  const share = () => openShareDialog({ target_type: 'node', target_id: docId, title: titleRef.current || '无标题文档' })

  const more = (el: HTMLElement) =>
    openMenu(el, [
      { label: '分享', icon: <IconShare />, onClick: share },
      {
        label: '导出 Markdown',
        icon: <IconDownload />,
        onClick: async () => {
          await save()
          await exportMarkdown('doc', docId)
        },
      },
      { label: '保存版本快照', icon: <IconCamera />, onClick: () => save({ snapshot: true }).then(() => toast('已保存快照')) },
      {
        label: '删除文档',
        icon: <IconTrash />,
        danger: true,
        divider: true,
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
        <nav className="crumbs">
          <Link to={`/r/${repoId}`} className="crumb-link">
            {repo && <RepoMark repo={repo} className="side-dot sm" />}
            <span className="ellipsis">{repo?.name}</span>
          </Link>
          <IconChevron className="crumb-sep" width={14} height={14} />
          <span className="crumb-cur ellipsis">{title.trim() || '无标题文档'}</span>
        </nav>
        <span className={'save-status ' + status}>{statusText[status]}</span>
        <span className="spacer" />
        {headings.length > 0 && (
          <button className="icon-btn outline-toggle" title="大纲" aria-label="大纲" onClick={() => setOutlineOpen((v) => !v)}>
            <IconList />
          </button>
        )}
        <button className="icon-btn hide-mobile" title="分享" aria-label="分享" onClick={share}>
          <IconShare />
        </button>
        <button
          className="icon-btn"
          title="历史版本" aria-label="历史版本"
          onClick={async () => {
            await save()
            setVersionsOpen(true)
          }}
        >
          <IconHistory />
        </button>
        <button className="icon-btn" title="更多" aria-label="更多" onClick={(e) => more(e.currentTarget)}>
          <IconMore />
        </button>
      </PageHeader>

      {status === 'conflict' && (
        <div className="banner warn">
          <span>这篇文档在其他窗口或设备上被修改过。</span>
          <button className="btn sm" onClick={showConflictDiff}>
            查看差异
          </button>
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
            <Backlinks nodeId={doc.id} repoId={repoId} />
          </div>
        </main>
        <Outline headings={headings} open={outlineOpen} onClose={() => setOutlineOpen(false)} />
      </div>

      <DocStats markdown={stats} updatedAt={savedAt} />

      {versionsOpen && (
        <VersionsPanel
          docId={docId}
          current={{ title: titleRef.current, markdown: getMd.current() }}
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

/** Count words the way Chinese editors do: each CJK character is a word, latin runs count once. */
function countWords(md: string) {
  const text = md
    .replace(/```(excalidraw|drawio|mindmap)\n[\s\S]*?\n```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, '')
    .replace(/[#>*_`~|[\]-]/g, ' ')
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9\u00C0-\u024F]+(?:['’.-][A-Za-z0-9]+)*/g)?.length ?? 0
  const chars = text.replace(/\s/g, '').length
  return { words: cjk + latin, chars }
}

function DocStats({ markdown, updatedAt }: { markdown: string; updatedAt: number }) {
  // the page re-renders on every save status change; only recount when the text changed
  const { words, chars } = useMemo(() => countWords(markdown), [markdown])
  const minutes = Math.max(1, Math.round(words / 400))
  return (
    <footer className="doc-stats">
      <span>{words.toLocaleString()} 字</span>
      <span>{chars.toLocaleString()} 字符</span>
      <span>约 {minutes} 分钟读完</span>
      <span className="spacer" />
      {updatedAt > 0 && <span className="hide-mobile">更新于 {new Date(updatedAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
    </footer>
  )
}
