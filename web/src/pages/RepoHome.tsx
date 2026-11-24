import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, formatTime, nodePath, type Repo, type TreeNode } from '../api'
import {
  IconClose,
  IconDoc,
  IconDocPlus,
  IconFolder,
  IconList,
  IconMore,
  IconSearch,
  IconShare,
  IconTable,
  IconUpload,
  RepoMark,
} from '../components/icons'
import { pickImport, runImport } from '../components/ImportDialog'
import { Crumb, PageBody, RowIcon, Section } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { repoMenu } from '../components/RepoDialog'
import { openShareDialog } from '../components/ShareDialog'
import { Badge, Button, cn, EmptyState, IconButton, Loading } from '../components/ui'
import { useWindowed } from '../components/useWindowed'
import { setPageMeta } from '../seo'
import { childrenMap, nodeTitle, useStore } from '../store'

export default function RepoHome() {
  const { repoId } = useParams() as { repoId: string }
  const { tree, treeRepoId, loadTree, loadRepos, repos } = useStore()
  const [repo, setRepo] = useState<Repo | null>(null)
  const [filter, setFilter] = useState('')
  const listed = repos.find((r) => r.id === repoId)
  useEffect(() => {
    if (listed) setRepo((r) => (r && r.id === listed.id ? { ...r, ...listed } : r))
  }, [listed])
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const reload = () =>
    api
      .repo(repoId)
      .then(setRepo)
      .catch((e) => setError(e.message))
  useEffect(() => {
    setRepo(null)
    setFilter('')
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId])

  useEffect(() => {
    if (repo) setPageMeta({ title: `${repo.name} - 青简`, description: repo.description })
  }, [repo])

  const nodes = useMemo(() => (treeRepoId === repoId ? tree : []), [treeRepoId, repoId, tree])
  const kids = useMemo(() => childrenMap(nodes), [nodes])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const newDoc = async () => {
    const n = await api.createNode(repoId, null, 'doc')
    await loadTree(repoId)
    navigate(`/r/${repoId}/d/${n.id}`)
  }

  const newTable = async () => {
    const n = await api.createNode(repoId, null, 'table', '未命名表格')
    await loadTree(repoId)
    navigate(`/r/${repoId}/t/${n.id}`)
  }

  const importFrom = async (folder: boolean) => {
    const picked = await pickImport(folder)
    if (!picked) return
    const res = await runImport(repoId, null, picked)
    if (!res) return
    await loadTree(repoId)
    loadRepos().catch(() => {})
    reload()
    if (res.docs === 1 && res.first) navigate(nodePath(res.first))
  }

  const trimmed = filter.trim().toLowerCase()
  const flat = useMemo(() => {
    const keep = trimmed ? new Set<string>() : null
    if (keep) {
      for (const n of nodes) {
        if (nodeTitle(n).toLowerCase().includes(trimmed)) {
          let cur: TreeNode | undefined = n
          while (cur) {
            keep.add(cur.id)
            cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
          }
        }
      }
    }
    const out: { n: TreeNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        if (keep && !keep.has(n.id)) continue
        out.push({ n, depth })
        walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [kids, nodes, byId, trimmed])

  const win = useWindowed<HTMLDivElement>(flat.length, 46)
  const docCount = useMemo(() => nodes.filter((n) => n.type === 'doc').length, [nodes])
  const tableCount = useMemo(() => nodes.filter((n) => n.type === 'table').length, [nodes])
  const groupCount = useMemo(() => nodes.filter((n) => n.type === 'group').length, [nodes])

  const renderRow = ({ n, depth }: { n: TreeNode; depth: number }) => {
    const cls = 'group flex h-[46px] items-center gap-3 border-b border-line-subtle pr-4 text-[13px] transition-colors duration-(--dur-fast) last:border-b-0'
    return n.type === 'group' ? (
      <div key={n.id} data-row className={cn(cls, 'bg-sunken/30 font-medium text-ink-2')} style={{ paddingLeft: 16 + depth * 22 }}>
        <RowIcon>
          <IconFolder />
        </RowIcon>
        <span className="min-w-0 flex-1 truncate">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={nodePath(n)} className={cn(cls, 'text-ink hover:bg-hover')} style={{ paddingLeft: 16 + depth * 22 }}>
        <RowIcon accent={n.type === 'table'}>{n.type === 'table' ? <IconTable /> : <IconDoc />}</RowIcon>
        <span className="min-w-0 flex-1 truncate font-medium group-hover:text-accent">{nodeTitle(n)}</span>
        {n.type === 'table' && (
          <Badge tone="accent" className="max-sm:hidden">
            表格
          </Badge>
        )}
        <span className="tabular shrink-0 text-[11.5px] text-ink-4">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  if (error)
    return (
      <div>
        <PageHeader />
        <PageBody>
          <EmptyState title="打不开这个知识库">{error}</EmptyState>
        </PageBody>
      </div>
    )

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb to="/">首页</Crumb>
          <Crumb current>{repo?.name}</Crumb>
        </Crumbs>
        {repo && (
          <>
            <IconButton
              label="分享知识库"
              className="max-sm:hidden"
              onClick={() => openShareDialog({ target_type: 'repo', target_id: repo.id, title: repo.name })}
            >
              <IconShare width={16} height={16} />
            </IconButton>
            <IconButton
              label="知识库设置"
              onClick={(e) =>
                repoMenu(
                  e.currentTarget,
                  repo,
                  () => {
                    reload()
                    loadRepos()
                  },
                  () => navigate('/'),
                  importFrom,
                )
              }
            >
              <IconMore width={16} height={16} />
            </IconButton>
          </>
        )}
      </PageHeader>
      {!repo ? (
        <Loading />
      ) : (
        <PageBody>
          <section className="rounded-2xl border border-line-subtle bg-surface p-5 shadow-card md:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <RepoMark repo={repo} size={54} className="shadow-sm" />
              <div className="min-w-0 flex-1">
                <h1 className="m-0 truncate text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink md:text-[25px]">{repo.name}</h1>
                {repo.description && <p className="mt-1 mb-0 line-clamp-2 text-[13px] leading-relaxed text-ink-2">{repo.description}</p>}
                <div className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-4">
                  <span>{docCount} 篇文档</span>
                  {tableCount > 0 && <span>· {tableCount} 个表格</span>}
                  {groupCount > 0 && <span>· {groupCount} 个分组</span>}
                  <span>· {formatTime(repo.updated_at)}更新</span>
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-4">
              <Button variant="primary" size="sm" icon={<IconDocPlus width={14} height={14} />} onClick={newDoc}>
                新建文档
              </Button>
              <Button size="sm" icon={<IconTable width={14} height={14} />} onClick={newTable}>
                新建表格
              </Button>
              <Button size="sm" variant="ghost" icon={<IconUpload width={14} height={14} />} onClick={() => importFrom(false)}>
                导入
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconShare width={14} height={14} />}
                onClick={() => openShareDialog({ target_type: 'repo', target_id: repo.id, title: repo.name })}
              >
                分享
              </Button>
            </div>
          </section>

          <Section
            title="目录"
            icon={<IconList />}
            count={nodes.length}
            className="mt-8"
            action={
              nodes.length > 5 && (
                <div className="flex h-8 w-48 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12.5px] focus-within:border-accent sm:w-56">
                  <IconSearch width={13} height={13} className="shrink-0 text-ink-4" />
                  <input
                    value={filter}
                    aria-label="在目录中搜索"
                    placeholder="筛选标题…"
                    className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus-visible:outline-none"
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
                  />
                  {filter && (
                    <button type="button" aria-label="清空" className="text-ink-4 hover:text-ink" onClick={() => setFilter('')}>
                      <IconClose width={12} height={12} />
                    </button>
                  )}
                </div>
              )
            }
          >
            <div className="overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-card" ref={win.listRef}>
              <div style={{ height: win.before }} />
              {flat.slice(win.start, win.end).map(renderRow)}
              <div style={{ height: win.after }} />
              {nodes.length === 0 && (
                <EmptyState
                  icon={<IconDoc />}
                  title="知识库还是空的"
                  className="py-14"
                  action={
                    <Button variant="primary" icon={<IconDocPlus width={15} height={15} />} onClick={newDoc}>
                      新建第一篇文档
                    </Button>
                  }
                />
              )}
              {nodes.length > 0 && trimmed && flat.length === 0 && <EmptyState title="没有匹配的目录项" className="py-10" />}
            </div>
          </Section>
        </PageBody>
      )}
    </div>
  )
}
