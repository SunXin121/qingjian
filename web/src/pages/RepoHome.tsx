import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, formatTime, nodePath, type Repo, type TreeNode } from '../api'
import { IconDoc, IconDocPlus, IconFolder, IconList, IconMore, IconTable, RepoMark } from '../components/icons'
import { pickImport, runImport } from '../components/ImportDialog'
import { Crumb, PageBody, RowIcon, Section } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { repoMenu } from '../components/RepoDialog'
import { Button, cn, EmptyState, IconButton, Loading } from '../components/ui'
import { useWindowed } from '../components/useWindowed'
import { childrenMap, nodeTitle, useStore } from '../store'

export default function RepoHome() {
  const { repoId } = useParams() as { repoId: string }
  const { tree, treeRepoId, loadTree, loadRepos, repos } = useStore()
  const [repo, setRepo] = useState<Repo | null>(null)
  // edits made elsewhere (the sidebar's menu) land in the store's list
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
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId])

  const nodes = useMemo(() => treeRepoId === repoId ? tree : [], [treeRepoId, repoId, tree])
  const kids = useMemo(() => childrenMap(nodes), [nodes])

  const newDoc = async () => {
    const n = await api.createNode(repoId, null, 'doc')
    await loadTree(repoId)
    navigate(`/r/${repoId}/d/${n.id}`)
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

  // the whole directory, flattened and rendered windowed (a repo can hold thousands of docs)
  const flat = useMemo(() => {
    const out: { n: TreeNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        out.push({ n, depth })
        walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [kids])
  const win = useWindowed<HTMLDivElement>(flat.length, 44)
  const docCount = useMemo(() => nodes.filter((n) => n.type === 'doc').length, [nodes])
  const tableCount = useMemo(() => nodes.filter((n) => n.type === 'table').length, [nodes])

  const renderRow = ({ n, depth }: { n: TreeNode; depth: number }) => {
    const cls = 'group flex h-11 items-center gap-3 border-b border-line-subtle pr-3.5 text-[13px] transition-colors duration-(--dur-fast) last:border-b-0'
    return n.type === 'group' ? (
      <div key={n.id} data-row className={cn(cls, 'font-medium text-ink-2')} style={{ paddingLeft: 14 + depth * 22 }}>
        <RowIcon>
          <IconFolder />
        </RowIcon>
        <span className="min-w-0 flex-1 truncate">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={nodePath(n)} className={cn(cls, 'text-ink hover:bg-hover')} style={{ paddingLeft: 14 + depth * 22 }}>
        <RowIcon accent={n.type === 'table'}>{n.type === 'table' ? <IconTable /> : <IconDoc />}</RowIcon>
        <span className="min-w-0 flex-1 truncate">{nodeTitle(n)}</span>
        <span className="tabular shrink-0 text-[11.5px] text-ink-4">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  if (error)
    return (
      <div>
        <PageHeader />
        <EmptyState title="打不开这个知识库">{error}</EmptyState>
      </div>
    )

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb>{repo?.name}</Crumb>
        </Crumbs>
        {repo && (
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
        )}
      </PageHeader>
      {!repo ? (
        <Loading />
      ) : (
        <PageBody>
          <section className="flex items-center gap-4">
            <RepoMark repo={repo} size={56} className="shadow-card" />
            <div className="min-w-0 flex-1">
              <h1 className="m-0 truncate text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink md:text-[26px]">{repo.name}</h1>
              <p className={'mt-1 mb-0 line-clamp-2 text-[13px] ' + (repo.description ? 'text-ink-2' : 'text-ink-4')}>{repo.description || '暂无简介'}</p>
              <div className="tabular mt-1.5 text-[11.5px] text-ink-4">
                {docCount} 篇文档
                {tableCount > 0 && ` · ${tableCount} 个表格`} · {formatTime(repo.updated_at)}更新
              </div>
            </div>
          </section>
          <Section
            title="目录"
            icon={<IconList />}
            className="mt-9"
            action={
              <Button variant="primary" size="sm" icon={<IconDocPlus width={14} height={14} />} onClick={newDoc}>
                新建文档
              </Button>
            }
          >
            <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-card" ref={win.listRef}>
              <div style={{ height: win.before }} />
              {flat.slice(win.start, win.end).map(renderRow)}
              <div style={{ height: win.after }} />
              {nodes.length === 0 && (
                <EmptyState icon={<IconDoc />} title="知识库还是空的" className="py-12">
                  新建一篇文档开始记录，或者从「···」菜单导入已有的 Markdown 文件。
                </EmptyState>
              )}
            </div>
          </Section>
        </PageBody>
      )}
    </div>
  )
}
