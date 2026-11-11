import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, formatTime, nodePath, type Repo, type TreeNode } from '../api'
import { IconDoc, IconDocPlus, IconFolder, IconList, IconMore, IconTable, RepoMark } from '../components/icons'
import { pickImport, runImport } from '../components/ImportDialog'
import PageHeader from '../components/PageHeader'
import { repoMenu } from '../components/RepoDialog'
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

  const nodes = treeRepoId === repoId ? tree : []
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
  const win = useWindowed<HTMLDivElement>(flat.length, 47)
  const docCount = useMemo(() => nodes.filter((n) => n.type === 'doc').length, [nodes])
  const tableCount = useMemo(() => nodes.filter((n) => n.type === 'table').length, [nodes])

  const renderRow = ({ n, depth }: { n: TreeNode; depth: number }, i: number) => {
    const last = win.start + i === flat.length - 1 ? ' last' : ''
    return n.type === 'group' ? (
      <div key={n.id} data-row className={'toc-row group' + last} style={{ paddingLeft: 12 + depth * 20 }}>
        <span className="doc-row-icon folder">
          <IconFolder width={16} height={16} />
        </span>
        <span className="ellipsis">{n.title || '未命名分组'}</span>
      </div>
    ) : (
      <Link key={n.id} data-row to={nodePath(n)} className={'toc-row' + last} style={{ paddingLeft: 12 + depth * 20 }}>
        <span className={'doc-row-icon' + (n.type === 'table' ? ' table' : '')}>
          {n.type === 'table' ? <IconTable width={16} height={16} /> : <IconDoc width={16} height={16} />}
        </span>
        <span className="ellipsis">{nodeTitle(n)}</span>
        <span className="spacer" />
        <span className="doc-row-time">{formatTime(n.updated_at)}</span>
      </Link>
    )
  }

  if (error) return <div className="page"><PageHeader /><div className="empty-state">{error}</div></div>

  return (
    <div className="page">
      <PageHeader>
        <span className="crumb ellipsis">{repo?.name}</span>
        <span className="spacer" />
        {repo && (
          <button
            className="icon-btn"
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
            <IconMore />
          </button>
        )}
      </PageHeader>
      <div className="page-body">
        {repo && (
          <>
            <section className="repo-hero">
              <RepoMark repo={repo} className="repo-hero-icon" />
              <div className="repo-hero-main">
                <h1 className="page-title">{repo.name}</h1>
                <p className={'repo-desc' + (repo.description ? '' : ' muted')}>{repo.description || '暂无简介'}</p>
                <div className="repo-hero-meta">
                  {docCount} 篇文档
                  {tableCount > 0 && ` · ${tableCount} 个表格`} · {formatTime(repo.updated_at)}更新
                </div>
              </div>
            </section>
            <div className="section-head">
              <h2>
                <IconList className="section-icon" width={17} height={17} />
                目录
              </h2>
              <button className="btn primary" onClick={newDoc}>
                <IconDocPlus width={16} height={16} /> 新建文档
              </button>
            </div>
            <div className="toc" ref={win.listRef}>
              <div style={{ height: win.before }} />
              {flat.slice(win.start, win.end).map(renderRow)}
              <div style={{ height: win.after }} />
              {nodes.length === 0 && <div className="empty-state small">知识库还是空的，新建一篇文档开始记录，或者从「···」菜单导入已有的 Markdown 文件吧。</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
