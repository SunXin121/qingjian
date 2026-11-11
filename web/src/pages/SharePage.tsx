import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, formatTime, shareApi, type PublicDoc, type PublicNode, type ShareInfo } from '../api'
import { IconChevron, IconDoc, IconFolder, IconList, IconLock, IconMenu, IconTable, Logo, RepoMark } from '../components/icons'
import { Crumb } from '../components/page'
import { Crumbs } from '../components/PageHeader'
import { Button, cn, EmptyState, IconButton, Input, Loading } from '../components/ui'
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

  if (state === 'loading') return <Loading className="min-h-dvh" />
  if (state === 'error')
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-base p-6 text-center">
        <img src="/favicon.svg" alt="" width="44" height="44" className="mb-2 rounded-xl shadow-card" />
        <h1 className="m-0 text-[18px] font-semibold text-ink">无法访问</h1>
        <p className="m-0 text-[13px] text-ink-3">{error || '链接不存在或已失效'}</p>
      </div>
    )
  if (state === 'password') return <PasswordGate token={token} onDone={load} />
  if (info!.type === 'repo') return <SharedRepo token={token} info={info!} />
  if (info!.node_type === 'table')
    return (
      <div className="page share-page table-page">
        <Suspense fallback={<Loading />}>
          <SharedTable token={token} tableId={info!.doc_id!} header={(extra) => <ShareHeader>{extra}</ShareHeader>} />
        </Suspense>
      </div>
    )
  return (
    <div className="flex min-h-dvh flex-col bg-editor">
      <SharedDoc token={token} docId={info!.doc_id!} header={(extra) => <ShareHeader>{extra}</ShareHeader>} />
    </div>
  )
}

function ShareHeader({ children, onMenu }: { children: React.ReactNode; onMenu?: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-[calc(var(--header-h)+var(--safe-t))] shrink-0 items-center gap-1 border-b border-line-subtle bg-[color-mix(in_oklab,var(--bg-editor)_86%,transparent)] px-2 pt-(--safe-t) backdrop-blur-md md:gap-2 md:px-4">
      {onMenu && (
        <IconButton label="目录" className="md:hidden" onClick={onMenu}>
          <IconMenu width={18} height={18} />
        </IconButton>
      )}
      {children}
    </header>
  )
}

function PasswordGate({ token, onDone }: { token: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-base p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(560px_420px_at_50%_30%,var(--accent-soft),transparent_70%)]" />
      <form
        className="relative flex w-full max-w-[340px] animate-rise flex-col items-center gap-3"
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
        <div className="grid size-14 place-items-center rounded-2xl border border-line-subtle bg-surface text-accent shadow-card">
          <IconLock width={24} height={24} />
        </div>
        <h1 className="mt-3 mb-0 text-[19px] font-semibold text-ink">需要访问密码</h1>
        <p className="mt-0 mb-3 text-[13px] text-ink-3">此内容由分享者设置了密码保护</p>
        <Input type="password" autoFocus autoComplete="off" placeholder="请输入访问密码" aria-label="访问密码" className="h-11 text-[14px] md:h-10" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="self-start text-[12.5px] text-danger">{err}</div>}
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pw}>
          {busy ? '验证中…' : '访问'}
        </Button>
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
          <Crumbs>
            <Crumb>{doc ? untitled(doc.title) : ''}</Crumb>
          </Crumbs>
          {headings.length > 0 && (
            <IconButton label="大纲" className="xl:hidden" active={outlineOpen} onClick={() => setOutlineOpen((v) => !v)}>
              <IconList width={16} height={16} />
            </IconButton>
          )}
        </>,
      )}
      {error ? (
        <EmptyState title="打不开这篇文档">{error}</EmptyState>
      ) : !doc ? (
        <Loading />
      ) : (
        <div className="flex flex-1 items-start">
          <main className="doc-main min-w-0 flex-1" onClickCapture={onClick}>
            <div className="mx-auto w-full max-w-[calc(var(--prose-width)+128px)] animate-rise px-5 pt-8 pb-[20vh] md:px-16 md:pt-14">
              <h1 className="mt-0 mb-2 text-[28px] leading-[1.3] font-bold tracking-[-0.015em] text-ink md:text-[34px]" style={{ fontFamily: 'var(--prose-font)' }}>
                {untitled(doc.title)}
              </h1>
              <div className="mb-7 text-[12px] text-ink-4">更新于 {formatTime(doc.updated_at)}</div>
              <Suspense fallback={<Loading />}>
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
  const tocWin = useWindowed<HTMLDivElement>(tocRows.length, 44)

  const renderTreeRow = ({ n, depth }: { n: PublicNode; depth: number }) => {
    const children = kids.get(n.id) ?? []
    const open = !collapsed.has(n.id)
    const active = n.id === docId
    const Icon = n.type === 'group' ? IconFolder : n.type === 'table' ? IconTable : IconDoc
    return (
      <div
        key={n.id}
        data-row
        className={cn(
          'mb-px flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[13px] transition-colors duration-(--dur-fast) select-none touch:h-10',
          active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => (n.type === 'group' ? toggle(n.id) : navigate(`${base}/${n.id}`))}
      >
        <button
          className={cn('grid size-5 shrink-0 place-items-center rounded-[4px] text-ink-4 transition-transform duration-(--dur-fast) hover:bg-active', open && 'rotate-90', !children.length && 'invisible')}
          tabIndex={-1}
          aria-label={open ? '折叠' : '展开'}
          onClick={(e) => {
            e.stopPropagation()
            toggle(n.id)
          }}
        >
          <IconChevron width={13} height={13} />
        </button>
        <Icon width={15} height={15} className={cn('shrink-0', active ? 'text-accent' : 'text-ink-3')} />
        <span className="min-w-0 flex-1 truncate pl-1">{nodeTitle(n)}</span>
      </div>
    )
  }

  const renderTocRow = ({ n, depth }: { n: PublicNode; depth: number }) => {
    const cls = 'flex h-11 items-center gap-3 border-b border-line-subtle pr-3.5 text-[13px] last:border-b-0 [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-ink-3'
    return n.type === 'group' ? (
      <div key={n.id} data-row className={cn(cls, 'font-medium text-ink-2')} style={{ paddingLeft: 14 + depth * 22 }}>
        <IconFolder />
        <span className="min-w-0 flex-1 truncate">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={`${base}/${n.id}`} className={cn(cls, 'text-ink transition-colors hover:bg-hover')} style={{ paddingLeft: 14 + depth * 22 }}>
        {n.type === 'table' ? <IconTable /> : <IconDoc />}
        <span className="min-w-0 flex-1 truncate">{nodeTitle(n)}</span>
        <span className="tabular shrink-0 text-[11.5px] text-ink-4">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  const header = (extra: React.ReactNode) => <ShareHeader onMenu={() => setSidebarOpen(true)}>{extra}</ShareHeader>

  const repoName = info.repo?.name ?? info.title
  return (
    <div className="share-shell flex min-h-dvh bg-editor">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-(--side-w) flex-col border-r border-line-subtle bg-sunken pt-(--safe-t)',
          'max-md:w-[min(300px,84vw)] max-md:-translate-x-full max-md:transition-transform max-md:duration-(--dur-base) max-md:ease-out',
          sidebarOpen && 'max-md:translate-x-0 max-md:shadow-modal',
        )}
      >
        <div className="flex h-12 shrink-0 items-center px-3">
          <Link to={base} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] font-semibold text-ink transition-colors hover:bg-hover">
            <RepoMark repo={{ id: token, name: repoName }} size={20} />
            <span className="truncate">{repoName}</span>
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          <div ref={treeWin.listRef}>
            <div style={{ height: treeWin.before }} />
            {treeRows.slice(treeWin.start, treeWin.end).map(renderTreeRow)}
            <div style={{ height: treeWin.after }} />
          </div>
          {nodes?.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">暂无文档</div>}
        </div>
        <div className="flex h-10 shrink-0 items-center justify-center gap-1.5 border-t border-line-subtle pb-(--safe-b) text-[11.5px] text-ink-4">
          <Logo size={14} className="rounded-[4px]" /> 由 青简 分享 · 只读
        </div>
      </aside>
      <div className={cn('fixed inset-0 z-[25] hidden animate-fade bg-scrim md:hidden', sidebarOpen && 'block')} onClick={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col md:ml-(--side-w)">
        {docId ? (
          ids.size > 0 && !ids.has(docId) ? (
            <>
              {header(null)}
              <EmptyState title="文档不存在">它可能已被删除，或不在这个分享中。</EmptyState>
            </>
          ) : current?.type === 'table' ? (
            <div className="table-page">
              <Suspense fallback={<Loading />}>
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
            {header(
              <Crumbs>
                <Crumb>{repoName}</Crumb>
              </Crumbs>,
            )}
            <div className="mx-auto w-full max-w-[920px] animate-rise px-4 pt-6 pb-24 md:px-8 md:pt-10">
              <div className="flex items-center gap-4">
                <RepoMark repo={{ id: token, name: repoName }} size={56} className="shadow-card" />
                <div className="min-w-0">
                  <h1 className="m-0 truncate text-[22px] leading-tight font-semibold text-ink md:text-[26px]">{repoName}</h1>
                  {info.repo?.description && <p className="mt-1 mb-0 text-[13px] text-ink-2">{info.repo.description}</p>}
                </div>
              </div>
              <h2 className="mt-9 mb-3 text-[13.5px] font-semibold text-ink">目录</h2>
              {error && <EmptyState title="目录加载失败">{error}</EmptyState>}
              <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-card" ref={tocWin.listRef}>
                <div style={{ height: tocWin.before }} />
                {tocRows.slice(tocWin.start, tocWin.end).map(renderTocRow)}
                <div style={{ height: tocWin.after }} />
                {nodes?.length === 0 && <EmptyState title="这个知识库还没有文档" className="py-12" />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
