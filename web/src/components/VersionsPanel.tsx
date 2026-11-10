import { lazy, Suspense, useEffect, useState } from 'react'
import { api, formatSize, formatTime, type Version } from '../api'
import { confirmDialog, toast } from './dialog'

const Editor = lazy(() => import('../editor/Editor'))

export default function VersionsPanel({ docId, onClose, onRestored }: { docId: string; onClose: () => void; onRestored: () => void }) {
  const [list, setList] = useState<Version[]>([])
  const [current, setCurrent] = useState<Version | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .versions(docId)
      .then((v) => {
        setList(v)
        if (v[0]) api.version(v[0].id).then(setCurrent)
      })
      .finally(() => setLoading(false))
  }, [docId])

  const restore = async () => {
    if (!current) return
    if (!(await confirmDialog(`将文档恢复到 ${formatTime(current.created_at)} 的版本？当前内容会先保存为一个新版本。`, { okText: '恢复' }))) return
    await api.restoreVersion(current.id)
    toast('已恢复')
    onRestored()
  }

  return (
    <div className="versions-overlay">
      <div className="versions-bar">
        <strong>历史版本</strong>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary" disabled={!current} onClick={restore}>
          恢复此版本
        </button>
      </div>
      <div className="versions-body">
        <div className="versions-list">
          {loading && <div className="side-empty">加载中…</div>}
          {!loading && list.length === 0 && <div className="side-empty">暂无历史版本</div>}
          {list.map((v) => (
            <button key={v.id} className={'version-item' + (current?.id === v.id ? ' active' : '')} onClick={() => api.version(v.id).then(setCurrent)}>
              <span>{formatTime(v.created_at)}</span>
              <small>{formatSize(v.size)}</small>
            </button>
          ))}
        </div>
        <div className="versions-preview">
          {current && (
            <div className="doc-body">
              <h1 className="version-title">{current.title || '无标题文档'}</h1>
              <Suspense fallback={null}>
                <Editor key={current.id} value={current.markdown ?? ''} readonly />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
