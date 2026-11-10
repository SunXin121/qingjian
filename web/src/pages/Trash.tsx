import { useEffect, useState } from 'react'
import { api, formatTime, type TrashItem } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconBook, IconDoc, IconFolder } from '../components/icons'
import PageHeader from '../components/PageHeader'
import { useStore } from '../store'

export default function Trash() {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const { loadRepos } = useStore()
  const load = () => api.trash().then(setItems)
  useEffect(() => {
    load()
  }, [])

  const restore = async (it: TrashItem) => {
    await api.restoreTrash(it.kind, it.id)
    toast('已恢复')
    load()
    if (it.kind === 'repo') loadRepos()
  }
  const purge = async (it: TrashItem) => {
    if (!(await confirmDialog(`彻底删除「${it.title || '无标题'}」？此操作不可撤销。`, { danger: true, okText: '彻底删除' }))) return
    await api.purgeTrash(it.kind, it.id)
    load()
  }

  return (
    <div className="page">
      <PageHeader>
        <span className="crumb">回收站</span>
      </PageHeader>
      <div className="page-body">
        <h1 className="page-title">回收站</h1>
        <p className="muted">删除的内容会在这里保留 30 天，之后自动清除。</p>
        <div className="doc-list">
          {items?.map((it) => (
            <div key={it.kind + it.id} className="doc-row">
              {it.kind === 'repo' ? <IconBook className="muted" /> : it.type === 'group' ? <IconFolder className="muted" /> : <IconDoc className="muted" />}
              <span className="doc-row-title ellipsis">{it.title || (it.type === 'group' ? '未命名分组' : '无标题文档')}</span>
              <span className="doc-row-repo ellipsis">{it.kind === 'repo' ? '知识库' : it.repo_name}</span>
              <span className="doc-row-time">{formatTime(it.deleted_at)}</span>
              <span className="row-actions">
                <button className="btn sm" onClick={() => restore(it)}>
                  恢复
                </button>
                <button className="btn sm danger" onClick={() => purge(it)}>
                  删除
                </button>
              </span>
            </div>
          ))}
          {items?.length === 0 && <div className="empty-state small">回收站是空的</div>}
        </div>
      </div>
    </div>
  )
}
