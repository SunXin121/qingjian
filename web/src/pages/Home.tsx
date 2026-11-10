import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, formatTime, type RecentDoc, type Repo } from '../api'
import { confirmDialog, openMenu, toast } from '../components/dialog'
import { editRepoDialog } from '../components/RepoDialog'
import { IconClock, IconDoc, IconDownload, IconEdit, IconLibrary, IconMore, IconPlus, IconSearch, IconShare, IconSparkles, IconTrash, RepoMark } from '../components/icons'
import PageHeader from '../components/PageHeader'
import { openShareDialog } from '../components/ShareDialog'
import { untitled, useStore } from '../store'

export function repoMenu(el: HTMLElement, r: Repo, after: () => void, onDeleted?: () => void) {
  openMenu(el, [
    {
      label: '编辑信息',
      icon: <IconEdit />,
      onClick: async () => {
        const v = await editRepoDialog(r)
        if (!v) return
        await api.updateRepo(r.id, v)
        after()
      },
    },
    { label: '分享知识库', icon: <IconShare />, onClick: () => openShareDialog({ target_type: 'repo', target_id: r.id, title: r.name }) },
    { label: '导出为 Markdown (zip)', icon: <IconDownload />, onClick: () => (location.href = `/api/repos/${r.id}/export`) },
    {
      label: '删除知识库',
      icon: <IconTrash />,
      danger: true,
      divider: true,
      onClick: async () => {
        if (!(await confirmDialog(`确定删除知识库「${r.name}」吗？可在回收站中恢复。`, { danger: true, okText: '删除' }))) return
        await api.deleteRepo(r.id)
        toast('已移入回收站')
        after()
        onDeleted?.()
      },
    },
  ])
}

export default function Home() {
  const { repos, loadRepos, setSearchOpen } = useStore()
  const [recent, setRecent] = useState<RecentDoc[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    loadRepos()
    api.recent().then(setRecent).catch(() => {})
  }, [loadRepos])

  const create = async () => {
    const v = await editRepoDialog()
    if (!v) return
    const r = await api.createRepo(v.name, v.description, v.icon)
    await loadRepos()
    navigate(`/r/${r.id}`)
  }

  const hour = new Date().getHours()
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <PageHeader>
        <span className="crumb">首页</span>
      </PageHeader>
      <div className="page-body">
        <section className="hero">
          <div className="hero-main">
            <div className="hero-date">
              <IconSparkles width={14} height={14} /> {today}
            </div>
            <h1 className="page-title">{greet}</h1>
            <p className="page-sub">记录、整理、沉淀，让每一条想法都有处安放。</p>
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-value">{repos.length}</span>
              <span className="hero-stat-label">知识库</span>
            </div>
            <div className="hero-stat">
              <span className="hero-stat-value">{repos.reduce((n, r) => n + r.doc_count, 0)}</span>
              <span className="hero-stat-label">文档</span>
            </div>
          </div>
          <div className="hero-actions">
            <button className="btn primary" onClick={create}>
              <IconPlus width={16} height={16} /> 新建知识库
            </button>
            <button className="btn" onClick={() => setSearchOpen(true)}>
              <IconSearch width={16} height={16} /> 搜索
            </button>
          </div>
        </section>

        <div className="section-head">
          <h2>
            <IconLibrary className="section-icon" width={17} height={17} />
            知识库{repos.length > 0 && <span className="section-count">{repos.length}</span>}
          </h2>
        </div>
        <div className="repo-grid">
          {repos.map((r) => (
            <Link key={r.id} to={`/r/${r.id}`} className="repo-card">
              <RepoMark repo={r} className="repo-card-icon" />
              <div className="repo-card-main">
                <div className="repo-card-name ellipsis">{r.name}</div>
                <div className={'repo-card-desc' + (r.description ? '' : ' empty')}>{r.description || '暂无简介'}</div>
                <div className="repo-card-meta">
                  <span>
                    <IconDoc width={13} height={13} /> {r.doc_count} 篇
                  </span>
                  <span>
                    <IconClock width={13} height={13} /> {formatTime(r.updated_at)}
                  </span>
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={(e) => {
                  e.preventDefault()
                  repoMenu(e.currentTarget, r, loadRepos)
                }}
              >
                <IconMore />
              </button>
            </Link>
          ))}
          {repos.length === 0 && (
            <button className="repo-card empty" onClick={create}>
              <IconPlus /> 创建你的第一个知识库
            </button>
          )}
        </div>

        {recent.length > 0 && (
          <>
            <div className="section-head">
              <h2>
                <IconClock className="section-icon" width={17} height={17} />
                最近编辑
              </h2>
            </div>
            <div className="doc-list">
              {recent.map((d) => (
                <Link key={d.id} to={`/r/${d.repo_id}/d/${d.id}`} className="doc-row">
                  <span className="doc-row-icon">
                    <IconDoc width={16} height={16} />
                  </span>
                  <span className="doc-row-title ellipsis">{untitled(d.title)}</span>
                  <span className="doc-row-repo ellipsis">{d.repo_name}</span>
                  <span className="doc-row-time">{formatTime(d.updated_at)}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
