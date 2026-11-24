import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, formatTime, shareApi, type PublicDoc, type PublicNode, type ShareInfo } from '../api'
import { copyText, toast } from '../components/dialog'
import {
  IconBack,
  IconChevron,
  IconClose,
  IconCopy,
  IconDoc,
  IconFolder,
  IconFolderOpen,
  IconForward,
  IconList,
  IconLock,
  IconMenu,
  IconMoon,
  IconSearch,
  IconSidebarClose,
  IconSidebarOpen,
  IconSun,
  IconTable,
  Logo,
  RepoMark,
} from '../components/icons'
import Outline, { parseHeadings } from '../components/Outline'
import { Crumb } from '../components/page'
import { Crumbs } from '../components/PageHeader'
import { Button, cn, EmptyState, IconButton, Input, Loading } from '../components/ui'
import { useWindowed } from '../components/useWindowed'
import { onAppEvent } from '../events'
import { plainExcerpt, setPageMeta } from '../seo'
import { childrenMap, nodeTitle, untitled } from '../store'
import { setEmbedSource } from '../table/embed'
import { isDark, onThemeModeChange, setThemeMode } from '../theme'

const Editor = lazy(() => import('../editor/Editor'))
const SharedTable = lazy(() => import('../table/SharedTable'))

const reInternalDoc = /^\/r\/[^/]+\/[dt]\/([0-9a-z]+)\/?$/

export default function SharePage() {
  const { token = '' } = useParams()
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [state, setState] = useState<'loading' | 'password' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    setEmbedSource(
      (id, viewId) => shareApi.table(token, id, viewId),
      () => null,
    )
  }, [token])

  const load = useCallback(async () => {
    try {
      const i = await shareApi.info(token)
      setInfo(i)
      setState('ready')
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) {
        setState('password')
        setPageMeta({ title: '受密码保护的分享 - 青简' })
      } else {
        setError(e.message)
        setState('error')
        setPageMeta({ title: '无法访问分享 - 青简' })
      }
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  if (state === 'loading') return <Loading className="min-h-dvh" />
  if (state === 'error')
    return (
      <main id="main-content" className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-base p-6 text-center">
        <img src="/favicon.svg" alt="" width="44" height="44" className="mb-2 rounded-xl shadow-card" />
        <h1 className="m-0 text-[18px] font-semibold text-ink">无法访问</h1>
        <p className="m-0 text-[13px] text-ink-3">{error || '链接不存在或已失效'}</p>
      </main>
    )
  if (state === 'password') return <PasswordGate token={token} onDone={load} />
  if (info!.type === 'repo' || info!.node_type === 'group') return <SharedRepo token={token} info={info!} />
  if (info!.node_type === 'table')
    return (
      <div className="page share-page table-page">
        <a href="#main-content" className="skip-link">
          跳转到主要内容
        </a>
        <Suspense fallback={<Loading />}>
          <SharedTable token={token} tableId={info!.doc_id!} header={(extra) => <ShareHeader token={token}>{extra}</ShareHeader>} />
        </Suspense>
      </div>
    )
  return (
    <div className="flex min-h-dvh flex-col bg-editor">
      <a href="#main-content" className="skip-link">
        跳转到主要内容
      </a>
      <SharedDoc
        token={token}
        docId={info!.doc_id!}
        allowIndexing={Boolean(info!.allow_indexing)}
        isCollection={false}
        header={(extra) => <ShareHeader token={token}>{extra}</ShareHeader>}
      />
    </div>
  )
}

function ShareHeader({
  children,
  token,
  docId,
  onMenu,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  children: React.ReactNode
  token: string
  docId?: string
  onMenu?: () => void
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
}) {
  const [dark, setDark] = useState(isDark)
  const [copying, setCopying] = useState(false)
  useEffect(() => onThemeModeChange(() => setDark(isDark())), [])

  const copyMd = async () => {
    if (copying) return
    setCopying(true)
    try {
      const md = await shareApi.markdown(token, docId)
      await copyText(md, '已复制 Markdown')
    } catch (e: any) {
      toast(e.message || '复制失败')
    } finally {
      setCopying(false)
    }
  }

  return (
    <header className="sticky top-0 z-20 flex h-[calc(var(--header-h)+var(--safe-t))] shrink-0 items-center gap-1 border-b border-line-subtle bg-[color-mix(in_oklab,var(--bg-editor)_88%,transparent)] px-2 pt-(--safe-t) backdrop-blur-md md:gap-2 md:px-4">
      {onMenu && (
        <IconButton label="打开目录" className="md:hidden" onClick={onMenu}>
          <IconMenu width={18} height={18} />
        </IconButton>
      )}
      {sidebarCollapsed && onExpandSidebar && (
        <IconButton label="展开侧边栏" className="max-md:hidden" onClick={onExpandSidebar}>
          <IconSidebarOpen width={17} height={17} />
        </IconButton>
      )}
      {children}
      <IconButton label="复制 Markdown" disabled={copying} onClick={copyMd}>
        <IconCopy width={15} height={15} />
      </IconButton>
      <IconButton
        label={dark ? '浅色模式' : '深色模式'}
        onClick={() => {
          const next = isDark() ? 'light' : 'dark'
          setThemeMode(next)
          setDark(next === 'dark')
        }}
      >
        {dark ? <IconSun width={15} height={15} /> : <IconMoon width={15} height={15} />}
      </IconButton>
    </header>
  )
}

function PasswordGate({ token, onDone }: { token: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main id="main-content" className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-base p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(560px_420px_at_50%_30%,var(--accent-soft),transparent_70%)]" />
      <form
        aria-label="输入分享访问密码"
        className="relative flex w-full max-w-[350px] animate-rise flex-col items-center rounded-2xl border border-line-subtle bg-surface px-6 py-8 shadow-modal"
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
        <div className="grid size-14 place-items-center rounded-2xl border border-line-subtle bg-inset text-accent">
          <IconLock width={24} height={24} />
        </div>
        <h1 className="mt-4 mb-5 text-[18px] font-semibold text-ink">输入访问密码</h1>
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          placeholder="访问密码"
          aria-label="访问密码"
          className="h-11 text-[14px] md:h-10"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && (
          <div role="alert" className="mt-2.5 w-full rounded-md bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-1.5 text-[12.5px] text-danger">
            {err}
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pw} className="mt-3.5">
          {busy ? '验证中…' : '访问'}
        </Button>
      </form>
    </main>
  )
}

interface AdjacentLink {
  id: string
  title: string
}

function SharedDoc({
  token,
  docId,
  repoHomeTitle,
  allowIndexing,
  isCollection,
  prevDoc,
  nextDoc,
  header,
  onInternalLink,
}: {
  token: string
  docId: string
  repoHomeTitle?: string
  allowIndexing?: boolean
  isCollection?: boolean
  prevDoc?: AdjacentLink | null
  nextDoc?: AdjacentLink | null
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
        const title = untitled(d.title)
        const path = isCollection ? `/s/${token}/${docId}` : `/s/${token}`
        setPageMeta({
          title: repoHomeTitle ? `${title} · ${repoHomeTitle} - 青简` : `${title} - 青简`,
          description: plainExcerpt(d.markdown) || `${title} — 青简分享文档。`,
          robots: allowIndexing ? 'index, follow' : 'noindex, nofollow',
          canonical: `${location.origin}${path}`,
          markdownAlternate: `${path}.md`,
        })
      })
      .catch((e) => setError(e.message))
    window.scrollTo(0, 0)
  }, [token, docId, repoHomeTitle, allowIndexing, isCollection])

  const headings = useMemo(() => (doc ? parseHeadings(doc.markdown) : []), [doc])

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
            {repoHomeTitle && <Crumb to={`/s/${token}`}>{repoHomeTitle}</Crumb>}
            <Crumb current={Boolean(repoHomeTitle)}>{doc ? untitled(doc.title) : ''}</Crumb>
          </Crumbs>
          {headings.length > 0 && (
            <IconButton label="文档大纲" className="xl:hidden" active={outlineOpen} onClick={() => setOutlineOpen((v) => !v)}>
              <IconList width={16} height={16} />
            </IconButton>
          )}
        </>,
      )}
      {error ? (
        <main id="main-content">
          <EmptyState title="打不开这篇文档">{error}</EmptyState>
        </main>
      ) : !doc ? (
        <main id="main-content">
          <Loading />
        </main>
      ) : (
        <div className="flex flex-1 items-start">
          <main id="main-content" className="doc-main min-w-0 flex-1" onClickCapture={onClick}>
            <article className="mx-auto w-full max-w-[calc(var(--prose-width)+128px)] animate-rise px-5 pt-8 pb-24 md:px-16 md:pt-14">
              <h1 className="mt-0 mb-2 text-[28px] leading-[1.3] font-bold tracking-[-0.015em] text-ink md:text-[34px]" style={{ fontFamily: 'var(--prose-font)' }}>
                {untitled(doc.title)}
              </h1>
              <div className="mb-8 flex items-center gap-3 text-[12px] text-ink-4">
                <time dateTime={new Date(doc.updated_at).toISOString()}>更新于 {formatTime(doc.updated_at)}</time>
              </div>
              <Suspense fallback={<Loading />}>
                <Editor key={doc.id} value={doc.markdown} readonly />
              </Suspense>

              {(prevDoc || nextDoc) && (
                <nav aria-label="上下篇文档导航" className="mt-16 grid gap-3 border-t border-line-subtle pt-6 sm:grid-cols-2">
                  {prevDoc ? (
                    <Link
                      to={`/s/${token}/${prevDoc.id}`}
                      className="group flex flex-col gap-1 rounded-xl border border-line-subtle bg-surface p-3.5 transition-[border-color,box-shadow] hover:border-line hover:shadow-card"
                    >
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-4">
                        <IconBack width={12} height={12} /> 上一篇
                      </span>
                      <span className="truncate text-[13.5px] font-medium text-ink group-hover:text-accent">{prevDoc.title}</span>
                    </Link>
                  ) : (
                    <div className="max-sm:hidden" />
                  )}
                  {nextDoc && (
                    <Link
                      to={`/s/${token}/${nextDoc.id}`}
                      className="group flex flex-col items-end gap-1 rounded-xl border border-line-subtle bg-surface p-3.5 text-right transition-[border-color,box-shadow] hover:border-line hover:shadow-card"
                    >
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-4">
                        下一篇 <IconForward width={12} height={12} />
                      </span>
                      <span className="max-w-full truncate text-[13.5px] font-medium text-ink group-hover:text-accent">{nextDoc.title}</span>
                    </Link>
                  )}
                </nav>
              )}
            </article>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    shareApi
      .tree(token)
      .then(setNodes)
      .catch((e) => setError(e.message))
  }, [token])

  const folder = info.type !== 'repo'
  const repoName = info.repo?.name ?? (info.title || (folder ? '未命名分组' : '未命名知识库'))
  const allowIndexing = Boolean(info.allow_indexing)

  useEffect(() => {
    setSidebarOpen(false)
    if (!docId) {
      setPageMeta({
        title: `${repoName} - 青简`,
        description: info.repo?.description || `${repoName} — 青简分享目录。`,
        robots: allowIndexing ? 'index, follow' : 'noindex, nofollow',
        canonical: `${location.origin}/s/${token}`,
        markdownAlternate: `/s/${token}.md`,
      })
    }
  }, [docId, repoName, info.repo?.description, allowIndexing, token])

  const kids = useMemo(() => childrenMap(nodes ?? []), [nodes])
  const byId = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes])
  const ids = useMemo(() => new Set((nodes ?? []).map((n) => n.id)), [nodes])
  const base = `/s/${token}`
  const current = nodes?.find((n) => n.id === docId)

  useEffect(() => {
    setEmbedSource(
      (id, viewId) => shareApi.table(token, id, viewId),
      (t, view) => (ids.has(t.id) ? `${base}/${t.id}?view=${view}` : null),
    )
    return onAppEvent('qj-nav', (path) => navigate(path))
  }, [token, ids, base, navigate])

  const toggle = (id: string) => {
    const s = new Set(collapsed)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setCollapsed(s)
  }

  const trimmedFilter = filter.trim().toLowerCase()
  const flatten = (skip: (id: string) => boolean, filterSet?: Set<string> | null) => {
    const out: { n: PublicNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        if (filterSet && !filterSet.has(n.id)) continue
        out.push({ n, depth })
        if (!skip(n.id)) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  const treeRows = useMemo(() => {
    if (!trimmedFilter) return flatten((id) => collapsed.has(id))
    const keep = new Set<string>()
    for (const n of nodes ?? []) {
      if (nodeTitle(n).toLowerCase().includes(trimmedFilter)) {
        let cur: PublicNode | undefined = n
        while (cur) {
          keep.add(cur.id)
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
        }
      }
    }
    return flatten(() => false, keep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, collapsed, trimmedFilter, nodes, byId])

  const tocRows = useMemo(() => flatten(() => false), [kids]) // eslint-disable-line react-hooks/exhaustive-deps
  const readableSeq = useMemo(
    () => tocRows.filter((r) => r.n.type === 'doc' || r.n.type === 'table').map((r) => ({ id: r.n.id, title: nodeTitle(r.n) })),
    [tocRows],
  )
  const curSeqIdx = docId ? readableSeq.findIndex((x) => x.id === docId) : -1
  const prevDoc = curSeqIdx > 0 ? readableSeq[curSeqIdx - 1] : null
  const nextDoc = curSeqIdx >= 0 && curSeqIdx < readableSeq.length - 1 ? readableSeq[curSeqIdx + 1] : null

  const treeWin = useWindowed<HTMLDivElement>(treeRows.length, 33)
  const tocWin = useWindowed<HTMLDivElement>(tocRows.length, 46)

  const renderTreeRow = ({ n, depth }: { n: PublicNode; depth: number }) => {
    const children = kids.get(n.id) ?? []
    const open = Boolean(trimmedFilter) || !collapsed.has(n.id)
    const active = n.id === docId
    const Icon = n.type === 'group' ? (open ? IconFolderOpen : IconFolder) : n.type === 'table' ? IconTable : IconDoc
    return (
      <div
        key={n.id}
        data-row
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={children.length > 0 ? open : undefined}
        aria-selected={active}
        className={cn(
          'mb-px flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[13px] transition-colors duration-(--dur-fast) outline-none select-none focus-visible:ring-2 focus-visible:ring-accent-ring touch:h-10',
          active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => (n.type === 'group' ? toggle(n.id) : navigate(`${base}/${n.id}`))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (n.type === 'group') toggle(n.id)
            else navigate(`${base}/${n.id}`)
          }
        }}
      >
        <button
          type="button"
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-[4px] text-ink-4 transition-transform duration-(--dur-fast) hover:bg-active',
            open && 'rotate-90',
            !children.length && 'invisible',
          )}
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
    const cls = 'group flex h-[46px] items-center gap-3 border-b border-line-subtle pr-4 text-[13px] last:border-b-0 [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-ink-3'
    return n.type === 'group' ? (
      <div key={n.id} data-row className={cn(cls, 'bg-sunken/30 font-medium text-ink-2')} style={{ paddingLeft: 16 + depth * 22 }}>
        <IconFolder />
        <span className="min-w-0 flex-1 truncate">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={`${base}/${n.id}`} className={cn(cls, 'text-ink transition-colors hover:bg-hover')} style={{ paddingLeft: 16 + depth * 22 }}>
        {n.type === 'table' ? <IconTable /> : <IconDoc />}
        <span className="min-w-0 flex-1 truncate font-medium group-hover:text-accent">{nodeTitle(n)}</span>
        <span className="tabular shrink-0 text-[11.5px] text-ink-4">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  const header = (extra: React.ReactNode) => (
    <ShareHeader
      token={token}
      docId={docId}
      onMenu={() => setSidebarOpen(true)}
      sidebarCollapsed={sidebarCollapsed}
      onExpandSidebar={() => setSidebarCollapsed(false)}
    >
      {extra}
    </ShareHeader>
  )

  return (
    <div className="share-shell flex min-h-dvh bg-editor">
      <a href="#main-content" className="skip-link">
        跳转到主要内容
      </a>
      <aside
        aria-label="分享目录导航"
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-(--side-w) flex-col border-r border-line-subtle bg-sunken pt-(--safe-t)',
          'transition-transform duration-(--dur-base) ease-out',
          'max-md:w-[min(300px,84vw)] max-md:-translate-x-full',
          sidebarOpen && 'max-md:translate-x-0 max-md:shadow-modal',
          sidebarCollapsed && 'md:-translate-x-full',
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-3">
          <Link to={base} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] font-semibold text-ink transition-colors hover:bg-hover">
            <RepoMark repo={{ id: token, name: repoName }} size={20} />
            <span className="truncate">{repoName}</span>
          </Link>
          <IconButton label="收起侧边栏" size="sm" className="max-md:hidden" onClick={() => setSidebarCollapsed(true)}>
            <IconSidebarClose width={15} height={15} />
          </IconButton>
        </div>

        {(nodes?.length ?? 0) > 5 && (
          <div className="mx-2.5 mb-2 flex h-7.5 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle bg-[color-mix(in_oklab,var(--bg-surface)_65%,transparent)] px-2 text-[12px] focus-within:border-line-strong focus-within:bg-surface">
            <IconSearch width={12} height={12} className="shrink-0 text-ink-4" />
            <input
              value={filter}
              aria-label="筛选分享目录"
              placeholder="筛选目录…"
              className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4 focus-visible:outline-none"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            />
            {filter && (
              <button type="button" aria-label="清空筛选" className="text-ink-4 hover:text-ink" onClick={() => setFilter('')}>
                <IconClose width={11} height={11} />
              </button>
            )}
          </div>
        )}

        <div role="tree" aria-label={`${repoName}目录树`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          <div ref={treeWin.listRef}>
            <div style={{ height: treeWin.before }} />
            {treeRows.slice(treeWin.start, treeWin.end).map(renderTreeRow)}
            <div style={{ height: treeWin.after }} />
          </div>
          {nodes?.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">暂无文档</div>}
          {(nodes?.length ?? 0) > 0 && trimmedFilter && treeRows.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-ink-4">没有匹配的文档</div>
          )}
        </div>
        <div className="flex h-10 shrink-0 items-center justify-center gap-1.5 border-t border-line-subtle pb-(--safe-b) text-[11.5px] text-ink-4">
          <Logo size={14} className="rounded-[4px]" /> 青简 · 只读
        </div>
      </aside>
      <div className={cn('fixed inset-0 z-[25] hidden animate-fade bg-scrim md:hidden', sidebarOpen && 'block')} onClick={() => setSidebarOpen(false)} />
      <div className={cn('flex min-w-0 flex-1 flex-col transition-[margin] duration-(--dur-base) ease-out', !sidebarCollapsed && 'md:ml-(--side-w)')}>
        {docId ? (
          ids.size > 0 && !ids.has(docId) ? (
            <>
              {header(null)}
              <main id="main-content">
                <EmptyState title="文档不存在" />
              </main>
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
              repoHomeTitle={repoName}
              allowIndexing={allowIndexing}
              isCollection
              prevDoc={prevDoc}
              nextDoc={nextDoc}
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
            <main id="main-content" className="mx-auto w-full max-w-[940px] animate-rise px-4 pt-6 pb-24 md:px-8 md:pt-10">
              <section className="rounded-2xl border border-line-subtle bg-surface p-5 shadow-card md:p-6">
                <div className="flex items-center gap-4">
                  <RepoMark repo={{ id: token, name: repoName }} size={54} className="shadow-sm" />
                  <div className="min-w-0 flex-1">
                    <h1 className="m-0 truncate text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink md:text-[25px]">{repoName}</h1>
                    {info.repo?.description && <p className="mt-1 mb-0 text-[13px] leading-relaxed text-ink-2">{info.repo.description}</p>}
                  </div>
                </div>
              </section>
              <h2 className="mt-8 mb-3 text-[13.5px] font-semibold text-ink">目录</h2>
              {error && <EmptyState title="目录加载失败">{error}</EmptyState>}
              <div className="overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-card" ref={tocWin.listRef}>
                <div style={{ height: tocWin.before }} />
                {tocRows.slice(tocWin.start, tocWin.end).map(renderTocRow)}
                <div style={{ height: tocWin.after }} />
                {nodes?.length === 0 && <EmptyState title="暂无文档" className="py-12" />}
              </div>
            </main>
          </>
        )}
      </div>
    </div>
  )
}
