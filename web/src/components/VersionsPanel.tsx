import { lazy, Suspense, useEffect, useState } from 'react'
import { api, formatSize, formatTime, type Version } from '../api'
import { confirmDialog, toast } from './dialog'

const Editor = lazy(() => import('../editor/Editor'))
const DiffView = lazy(() => import('./DiffView'))

type Mode = 'preview' | 'prev' | 'current'

const withTitle = (title: string, md: string) => `# ${title.trim() || '无标题文档'}\n\n${md}`

export default function VersionsPanel({
  docId,
  current,
  onClose,
  onRestored,
}: {
  docId: string
  current: { title: string; markdown: string }
  onClose: () => void
  onRestored: () => void
}) {
  const [list, setList] = useState<Version[]>([])
  const [selected, setSelected] = useState<Version | null>(null)
  const [prev, setPrev] = useState<Version | null>(null)
  const [mode, setMode] = useState<Mode>('preview')
  const [loading, setLoading] = useState(true)

  const select = async (v: Version, all = list) => {
    const i = all.findIndex((x) => x.id === v.id)
    const [full, before] = await Promise.all([api.version(v.id), all[i + 1] ? api.version(all[i + 1].id) : Promise.resolve(null)])
    setSelected(full)
    setPrev(before)
  }

  useEffect(() => {
    api
      .versions(docId)
      .then((v) => {
        setList(v)
        if (v[0]) select(v[0], v)
      })
      .catch((e) => toast(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const restore = async () => {
    if (!selected) return
    if (!(await confirmDialog(`将文档恢复到 ${formatTime(selected.created_at)} 的版本？当前内容会先保存为一个新版本。`, { okText: '恢复' }))) return
    await api.restoreVersion(selected.id)
    toast('已恢复')
    onRestored()
  }

  let content = null
  if (selected) {
    const md = selected.markdown ?? ''
    if (mode === 'preview') {
      content = (
        <div className="doc-body">
          <h1 className="version-title">{selected.title || '无标题文档'}</h1>
          <Suspense fallback={null}>
            <Editor key={selected.id} value={md} readonly />
          </Suspense>
        </div>
      )
    } else if (mode === 'prev' && !prev) {
      content = <div className="side-empty">这是最早的版本，没有可对比的上一版本</div>
    } else {
      const [oldText, newText, oldLabel, newLabel] =
        mode === 'prev'
          ? [withTitle(prev!.title, prev!.markdown ?? ''), withTitle(selected.title, md), `上一版本 · ${formatTime(prev!.created_at)}`, `此版本 · ${formatTime(selected.created_at)}`]
          : [withTitle(selected.title, md), withTitle(current.title, current.markdown), `此版本 · ${formatTime(selected.created_at)}`, '当前内容']
      content = (
        <Suspense fallback={<div className="ink-loading">加载中…</div>}>
          <DiffView oldText={oldText} newText={newText} oldLabel={oldLabel} newLabel={newLabel} />
        </Suspense>
      )
    }
  }

  return (
    <div className="versions-overlay">
      <div className="versions-bar">
        <strong className="versions-heading">历史版本</strong>
        <div className="seg">
          {(
            [
              ['preview', '预览'],
              ['prev', '对比上一版'],
              ['current', '对比当前'],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary" disabled={!selected} onClick={restore}>
          恢复
        </button>
      </div>
      <div className="versions-body">
        <div className="versions-list">
          {loading && <div className="side-empty">加载中…</div>}
          {!loading && list.length === 0 && <div className="side-empty">暂无历史版本</div>}
          {list.map((v) => (
            <button key={v.id} className={'version-item' + (selected?.id === v.id ? ' active' : '')} onClick={() => select(v)}>
              <span>{formatTime(v.created_at)}</span>
              <small>{formatSize(v.size)}</small>
            </button>
          ))}
        </div>
        <div className="versions-preview">{content}</div>
      </div>
    </div>
  )
}
