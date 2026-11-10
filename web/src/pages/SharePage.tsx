import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, formatTime, shareApi, type PublicDoc, type PublicNode, type ShareInfo } from '../api'
import { IconChevron, IconDoc, IconFolder, IconList, IconLock, IconMenu, IconTable } from '../components/icons'
import Outline, { parseHeadings } from '../components/Outline'
import { useWindowed } from '../components/useWindowed'
import { childrenMap, nodeTitle, untitled } from '../store'
import { setEmbedSource } from '../table/embed'

const Editor = lazy(() => import('../editor/Editor'))
const SharedTable = lazy(() => import('../table/SharedTable'))

const reInternalDoc = /^\/r\/[^/]+\/[dt]\/([0-9a-z]+)\/?$/

/** Public, read-only view of a share link: /s/:token[/:docId] */
export default function SharePage() {
  const { token = '' } = useParams()
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [state, setState] = useState<'loading' | 'password' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')

  // tables embedded in shared docs are read through the share
  useEffect(() => {
    setEmbedSource(
      (id) => shareApi.table(token, id),
      () => null,
    )
  }, [token])

  const load = useCallback(async () => {
    try {
      const i = await shareApi.info(token)
      setInfo(i)
      setState('ready')
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) setState('password')
      else {
        setError(e.message)
        setState('error')
      }
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  if (state === 'loading') return <div className="ink-loading">加载中…</div>
  if (state === 'error')
    return (
      <div className="share-message">
        <img src="/favicon.svg" alt="" width="40" height="40" />
        <h1>无法访问</h1>
        <p className="muted">{error || '链接不存在或已失效'}</p>
      </div>
    )
  if (state === 'password') return <PasswordGate token={token} onDone={load} />
  if (info!.type === 'repo') return <SharedRepo token={token} info={info!} />
  if (info!.node_type === 'table')
    return (
      <div className="page share-page table-page">
        <Suspense fallback={<div className="ink-loading">加载中…</div>}>
          <SharedTable token={token} tableId={info!.doc_id!} header={(extra) => <header className="page-header share-header">{extra}</header>} />
        </Suspense>
      </div>
    )
  return (
    <div className="page share-page">
      <SharedDoc token={token} docId={info!.doc_id!} header={(extra) => <header className="page-header share-header">{extra}</header>} />
    </div>
  )
}

function PasswordGate({ token, onDone }: { token: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr('')
          try {
            await shareApi.auth(token, pw)
            onDone()
          } catch (e: any) {
            setErr(e.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="share-lock">
          <IconLock width={28} height={28} />
        </div>
        <h1>需要访问密码</h1>
        <p className="muted">此内容由分享者设置了密码保护</p>
        <input type="password" autoFocus autoComplete="off" placeholder="请输入访问密码" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="login-error">{err}</div>}
        <button className="btn primary block" disabled={busy || !pw}>
          {busy ? '验证中…' : '访问'}
        </button>
      </form>
    </div>
  )
}

function SharedDoc({
  token,
  docId,
  header,
  onInternalLink,
}: {
  token: string
  docId: string
  header: (extra: React.ReactNode) => React.ReactNode
  onInternalLink?: (docId: string) => boolean
}) {
  const [doc, setDoc] = useState<PublicDoc | null>(null)
  const [error, setError] = useState('')
  const [outlineOpen, setOutlineOpen] = useState(false)

  useEffect(() => {
    setDoc(null)
    setError('')
    shareApi
      .doc(token, docId)
      .then((d) => {
        setDoc(d)
        document.title = `${untitled(d.title)} - 青简`
      })
      .catch((e) => setError(e.message))
    window.scrollTo(0, 0)
  }, [token, docId])

  const headings = useMemo(() => (doc ? parseHeadings(doc.markdown) : []), [doc])

  // links to other docs of a shared repo stay inside the share
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.('a')
    if (!a || !onInternalLink) return
    const href = a.getAttribute('href') || ''
    let u: URL
    try {
      u = new URL(href, location.href)
    } catch {
      return
    }
    const m = u.origin === location.origin && reInternalDoc.exec(u.pathname)
    if (m && onInternalLink(m[1])) e.preventDefault()
  }

  return (
    <>
      {header(
        <>
          <span className="crumb ellipsis">{doc ? untitled(doc.title) : ''}</span>
          <span className="spacer" />
          {headings.length > 0 && (
            <button className="icon-btn outline-toggle" title="大纲" onClick={() => setOutlineOpen((v) => !v)}>
              <IconList />
            </button>
          )}
        </>,
      )}
      {error ? (
        <div className="empty-state">{error}</div>
      ) : !doc ? (
        <div className="ink-loading">加载中…</div>
      ) : (
        <div className="doc-layout">
          <main className="doc-main" onClickCapture={onClick}>
            <div className="doc-body">
              <h1 className="share-doc-title">{untitled(doc.title)}</h1>
              <div className="share-doc-meta">更新于 {formatTime(doc.updated_at)}</div>
              <Suspense fallback={<div className="ink-loading">加载中…</div>}>
                <Editor key={doc.id} value={doc.markdown} readonly />
              </Suspense>
            </div>
          </main>
          <Outline headings={headings} open={outlineOpen} onClose={() => setOutlineOpen(false)} />
        </div>
      )}
    </>
  )
}

function SharedRepo({ token, info }: { token: string; info: ShareInfo }) {
  const { docId } = useParams()
  const navigate = useNavigate()
  const [nodes, setNodes] = useState<PublicNode[] | null>(null)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    shareApi
      .tree(token)
      .then(setNodes)
      .catch((e) => setError(e.message))
  }, [token])

  useEffect(() => {
    setSidebarOpen(false)
    if (!docId) document.title = `${info.repo?.name ?? info.title} - 青简`
  }, [docId, info])

  const kids = useMemo(() => childrenMap(nodes ?? []), [nodes])
  const ids = useMemo(() => new Set((nodes ?? []).map((n) => n.id)), [nodes])
  const base = `/s/${token}`
  const current = nodes?.find((n) => n.id === docId)

  // tables of the shared repo open inside the share
  useEffect(() => {
    setEmbedSource(
      (id) => shareApi.table(token, id),
      (t, view) => (ids.has(t.id) ? `${base}/${t.id}?view=${view}` : null),
    )
    const onNav = (e: Event) => navigate((e as CustomEvent<string>).detail)
    window.addEventListener('qj-nav', onNav)
    return () => window.removeEventListener('qj-nav', onNav)
  }, [token, ids, base, navigate])

  const toggle = (id: string) => {
    const s = new Set(collapsed)
    s.has(id) ? s.delete(id) : s.add(id)
    setCollapsed(s)
  }

  // sidebar tree (expanded part) and home directory as flat lists, rendered windowed
  const flatten = (skip: (id: string) => boolean) => {
    const out: { n: PublicNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        out.push({ n, depth })
        if (!skip(n.id)) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }
  const treeRows = useMemo(() => flatten((id) => collapsed.has(id)), [kids, collapsed]) // eslint-disable-line react-hooks/exhaustive-deps
  const tocRows = useMemo(() => flatten(() => false), [kids]) // eslint-disable-line react-hooks/exhaustive-deps
  const treeWin = useWindowed<HTMLDivElement>(treeRows.length, 33)
  const tocWin = useWindowed<HTMLDivElement>(tocRows.length, 47)

  const renderTreeRow = ({ n, depth }: { n: PublicNode; depth: number }) => {
    const children = kids.get(n.id) ?? []
    const open = !collapsed.has(n.id)
    return (
      <div
        key={n.id}
        data-row
        className={'tree-item' + (n.id === docId ? ' active' : '')}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => (n.type === 'group' ? toggle(n.id) : navigate(`${base}/${n.id}`))}
      >
        <button
          className={'tree-toggle' + (open ? ' open' : '') + (children.length ? '' : ' invisible')}
          onClick={(e) => {
            e.stopPropagation()
            toggle(n.id)
          }}
        >
          <IconChevron width={14} height={14} />
        </button>
        {n.type === 'group' ? <IconFolder className="tree-icon" /> : n.type === 'table' ? <IconTable className="tree-icon" /> : <IconDoc className="tree-icon" />}
        <span className="tree-title">{nodeTitle(n)}</span>
      </div>
    )
  }

  const renderTocRow = ({ n, depth }: { n: PublicNode; depth: number }, i: number) => {
    const last = tocWin.start + i === tocRows.length - 1 ? ' last' : ''
    return n.type === 'group' ? (
      <div key={n.id} data-row className={'toc-row group' + last} style={{ paddingLeft: 12 + depth * 20 }}>
        <IconFolder className="muted" />
        <span className="ellipsis">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={`${base}/${n.id}`} className={'toc-row' + last} style={{ paddingLeft: 12 + depth * 20 }}>
        {n.type === 'table' ? <IconTable className="muted" /> : <IconDoc className="muted" />}
        <span className="ellipsis">{nodeTitle(n)}</span>
        <span className="spacer" />
        <span className="doc-row-time">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  const header = (extra: React.ReactNode) => (
    <header className="page-header share-header">
      <button className="icon-btn mobile-only" title="目录" onClick={() => setSidebarOpen(true)}>
        <IconMenu />
      </button>
      {extra}
    </header>
  )

  const repoName = info.repo?.name ?? info.title
  return (
    <div className={'shell share-shell' + (sidebarOpen ? ' sidebar-open' : '')}>
      <aside className="sidebar">
        <div className="repo-head share-repo-head">
          <Link to={base} className="repo-name ellipsis">
            {repoName}
          </Link>
        </div>
        <div className="side-scroll tree">
          <div ref={treeWin.listRef}>
            <div style={{ height: treeWin.before }} />
            {treeRows.slice(treeWin.start, treeWin.end).map(renderTreeRow)}
            <div style={{ height: treeWin.after }} />
          </div>
          {nodes?.length === 0 && <div className="side-empty">暂无文档</div>}
        </div>
        <div className="sidebar-foot share-foot">由 青简 分享 · 只读</div>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <div className="content">
        <div className="page">
          {docId ? (
            ids.size > 0 && !ids.has(docId) ? (
              <>
                {header(null)}
                <div className="empty-state">文档不存在</div>
              </>
            ) : current?.type === 'table' ? (
              <div className="table-page">
                <Suspense fallback={<div className="ink-loading">加载中…</div>}>
                  <SharedTable key={docId} token={token} tableId={docId} header={header} />
                </Suspense>
              </div>
            ) : (
              <SharedDoc
                token={token}
                docId={docId}
                header={header}
                onInternalLink={(id) => {
                  if (!ids.has(id)) return false
                  navigate(`${base}/${id}`)
                  return true
                }}
              />
            )
          ) : (
            <>
              {header(<span className="crumb ellipsis">{repoName}</span>)}
              <div className="page-body">
                <h1 className="page-title">{repoName}</h1>
                {info.repo?.description && <p className="repo-desc">{info.repo.description}</p>}
                <div className="section-head">
                  <h2>目录</h2>
                </div>
                {error && <div className="empty-state small">{error}</div>}
                <div className="toc" ref={tocWin.listRef}>
                  <div style={{ height: tocWin.before }} />
                  {tocRows.slice(tocWin.start, tocWin.end).map(renderTocRow)}
                  <div style={{ height: tocWin.after }} />
                  {nodes?.length === 0 && <div className="empty-state small">这个知识库还没有文档</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
