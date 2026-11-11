import { lazy, Suspense, useEffect, useState } from 'react'
import { api, formatSize, formatTime, type Version } from '../api'
import { confirmDialog, toast } from './dialog'
import { IconClose, IconHistory } from './icons'
import { Button, cn, EmptyState, IconButton, Loading, Segmented } from './ui'

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
        <div className="mx-auto w-full max-w-[calc(var(--prose-width)+128px)] px-5 pt-8 pb-[20vh] md:px-16 md:pt-12">
          <h1 className="mt-0 mb-5 text-[28px] leading-tight font-bold tracking-[-0.015em] text-ink md:text-[32px]" style={{ fontFamily: 'var(--prose-font)' }}>
            {selected.title || '无标题文档'}
          </h1>
          <Suspense fallback={null}>
            <Editor key={selected.id} value={md} readonly />
          </Suspense>
        </div>
      )
    } else if (mode === 'prev' && !prev) {
      content = <EmptyState title="没有上一版本">这是最早的版本，没有可对比的上一版本。</EmptyState>
    } else {
      const [oldText, newText, oldLabel, newLabel] =
        mode === 'prev'
          ? [withTitle(prev!.title, prev!.markdown ?? ''), withTitle(selected.title, md), `上一版本 · ${formatTime(prev!.created_at)}`, `此版本 · ${formatTime(selected.created_at)}`]
          : [withTitle(selected.title, md), withTitle(current.title, current.markdown), `此版本 · ${formatTime(selected.created_at)}`, '当前内容']
      content = (
        <Suspense fallback={<Loading />}>
          <DiffView oldText={oldText} newText={newText} oldLabel={oldLabel} newLabel={newLabel} />
        </Suspense>
      )
    }
  }

  return (
    <div className="fixed inset-0 z-60 flex animate-fade flex-col bg-editor">
      <div className="flex h-[calc(var(--header-h)+var(--safe-t))] shrink-0 items-center gap-2 border-b border-line-subtle px-3 pt-(--safe-t) md:px-4">
        <IconHistory width={16} height={16} className="shrink-0 text-ink-3 max-sm:hidden" />
        <strong className="mr-2 text-[13.5px] font-semibold text-ink max-sm:hidden">历史版本</strong>
        <Segmented
          label="查看方式"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'preview', label: '预览' },
            { value: 'prev', label: '对比上一版' },
            { value: 'current', label: '对比当前' },
          ]}
        />
        <span className="flex-1" />
        <Button variant="primary" disabled={!selected} onClick={restore}>
          恢复此版本
        </Button>
        <IconButton label="关闭" onClick={onClose}>
          <IconClose width={17} height={17} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="no-scrollbar shrink-0 overflow-y-auto border-line-subtle bg-sunken p-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:border-b md:w-60 md:border-r">
          {loading && <Loading className="py-10" />}
          {!loading && list.length === 0 && <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">暂无历史版本</div>}
          {list.map((v) => {
            const on = selected?.id === v.id
            return (
              <button
                key={v.id}
                className={cn(
                  'mb-px flex h-10 w-full shrink-0 items-center justify-between gap-3 rounded-md px-3 text-[12.5px] transition-colors duration-(--dur-fast) max-md:h-12 max-md:w-auto max-md:flex-col max-md:justify-center max-md:gap-0',
                  on ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
                )}
                onClick={() => select(v)}
              >
                <span className="whitespace-nowrap">{formatTime(v.created_at)}</span>
                <small className={cn('tabular text-[11px] font-normal', on ? 'text-accent/70' : 'text-ink-4')}>{formatSize(v.size)}</small>
              </button>
            )
          })}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">{content}</div>
      </div>
    </div>
  )
}
