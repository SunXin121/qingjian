import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, formatTime, type RecentDoc, type Repo } from '../api'
import { confirmDialog, openMenu, promptForm, toast } from '../components/dialog'
import { IconBook, IconDoc, IconMore, IconPlus } from '../components/icons'
import PageHeader from '../components/PageHeader'
import { untitled, useStore } from '../store'

export async function editRepoDialog(repo?: Repo) {
  return promptForm(
    repo ? '编辑知识库' : '新建知识库',
    [
      { name: 'name', label: '名称', value: repo?.name, placeholder: '例如：读书笔记', required: true },
      { name: 'description', label: '简介', value: repo?.description, placeholder: '可选', multiline: true },
    ],
    repo ? '保存' : '创建',
  )
}

export function repoMenu(el: HTMLElement, r: Repo, after: () => void, onDeleted?: () => void) {
  openMenu(el, [
    {
      label: '编辑信息',
      onClick: async () => {
        const v = await editRepoDialog(r)
        if (!v) return
        await api.updateRepo(r.id, { name: v.name, description: v.description })
        after()
      },
    },
    { label: '导出为 Markdown (zip)', onClick: () => (location.href = `/api/repos/${r.id}/export`) },
    {
      label: '删除知识库',
      danger: true,
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
  const { repos, loadRepos } = useStore()
  const [recent, setRecent] = useState<RecentDoc[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    loadRepos()
    api.recent().then(setRecent).catch(() => {})
  }, [loadRepos])

  const create = async () => {
    const v = await editRepoDialog()
    if (!v) return
    const r = await api.createRepo(v.name, v.description)
    await loadRepos()
    navigate(`/r/${r.id}`)
  }

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <PageHeader>
        <span className="crumb">首页</span>
      </PageHeader>
      <div className="page-body">
        <h1 className="page-title">{greet}</h1>

        <div className="section-head">
          <h2>知识库</h2>
          <button className="btn primary" onClick={create}>
            <IconPlus width={16} height={16} /> 新建知识库
          </button>
        </div>
        <div className="repo-grid">
          {repos.map((r) => (
            <Link key={r.id} to={`/r/${r.id}`} className="repo-card">
              <div className="repo-card-icon">
                <IconBook />
              </div>
              <div className="repo-card-main">
                <div className="repo-card-name ellipsis">{r.name}</div>
                <div className="repo-card-desc">{r.description || '暂无简介'}</div>
                <div className="repo-card-meta">
                  {r.doc_count} 篇文档 · {formatTime(r.updated_at)}更新
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
              <h2>最近编辑</h2>
            </div>
            <div className="doc-list">
              {recent.map((d) => (
                <Link key={d.id} to={`/r/${d.repo_id}/d/${d.id}`} className="doc-row">
                  <IconDoc className="muted" />
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
