import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, formatTime, type Repo, type TreeNode } from '../api'
import { IconDoc, IconFolder, IconMore, IconPlus } from '../components/icons'
import PageHeader from '../components/PageHeader'
import { childrenMap, untitled, useStore } from '../store'
import { repoMenu } from './Home'

export default function RepoHome() {
  const { repoId } = useParams() as { repoId: string }
  const { tree, treeRepoId, loadTree, loadRepos } = useStore()
  const [repo, setRepo] = useState<Repo | null>(null)
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

  const renderList = (parent: string | null, depth: number): React.ReactNode =>
    (kids.get(parent) ?? []).map((n: TreeNode) => (
      <div key={n.id}>
        {n.type === 'group' ? (
          <div className="toc-row group" style={{ paddingLeft: 12 + depth * 20 }}>
            <IconFolder className="muted" />
            <span className="ellipsis">{n.title || '未命名分组'}</span>
          </div>
        ) : (
          <Link to={`/r/${repoId}/d/${n.id}`} className="toc-row" style={{ paddingLeft: 12 + depth * 20 }}>
            <IconDoc className="muted" />
            <span className="ellipsis">{untitled(n.title)}</span>
            <span className="spacer" />
            <span className="doc-row-time">{formatTime(n.updated_at)}</span>
          </Link>
        )}
        {renderList(n.id, depth + 1)}
      </div>
    ))

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
            <h1 className="page-title">{repo.name}</h1>
            {repo.description && <p className="repo-desc">{repo.description}</p>}
            <div className="section-head">
              <h2>目录</h2>
              <button className="btn primary" onClick={newDoc}>
                <IconPlus width={16} height={16} /> 新建文档
              </button>
            </div>
            <div className="toc">
              {renderList(null, 0)}
              {nodes.length === 0 && <div className="empty-state small">知识库还是空的，新建一篇文档开始记录吧。</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
