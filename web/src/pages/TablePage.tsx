import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { api, ApiError, formatTime } from '../api'
import { BacklinkList, useBacklinks } from '../components/Backlinks'
import { confirmDialog, openMenu, openPopover, toast } from '../components/dialog'
import { IconDownload, IconLink, IconMore, IconShare, IconTrash, IconUpload, RepoMark } from '../components/icons'
import { Crumb } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Button, cn, IconButton } from '../components/ui'
import { openShareDialog } from '../components/ShareDialog'
import { useStore } from '../store'
import { exportCSV, importCSV } from '../table/csv'
import { pickFiles } from '../table/editors'
import { TableModel, useSyncState, useTable } from '../table/model'
import TableView from '../table/TableView'
import '../table/table.css'

const lastViewKey = (id: string) => `qj.view.${id}`

export default function TablePage() {
  const { repoId, tableId } = useParams() as { repoId: string; tableId: string }
  const [model, setModel] = useState<TableModel | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const data = await api.table(tableId)
      setModel((m) => {
        if (m && m.state.id === data.id) {
          m.reset(data)
          return m
        }
        const next = new TableModel(data, { onReload: () => load(), fetchTable: (id) => api.table(id) })
        return next
      })
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 404 ? '表格不存在或已被删除' : e.message)
    }
  }, [tableId])

  useEffect(() => {
    setModel(null)
    load()
  }, [load])

  if (error)
    return (
      <div className="page">
        <PageHeader />
        <div className="empty-state">{error}</div>
      </div>
    )
  if (!model || model.state.id !== tableId)
    return (
      <div className="page">
        <PageHeader />
        <div className="ink-loading">加载中…</div>
      </div>
    )
  return <TableScreen key={model.state.id} model={model} repoId={repoId} />
}

function TableScreen({ model, repoId }: { model: TableModel; repoId: string }) {
  const table = useTable(model)
  const sync = useSyncState(model)
  const { repos, patchNode, loadTree } = useStore()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [title, setTitle] = useState(table.title)
  const titleRef = useRef(table.title)
  const repo = repos.find((r) => r.id === repoId)
  const backlinks = useBacklinks(table.id)

  const viewParam = params.get('view') ?? undefined
  const [viewId, setViewId] = useState<string | undefined>(() => {
    if (viewParam && table.views.some((v) => v.id === viewParam)) return viewParam
    try {
      const saved = localStorage.getItem(lastViewKey(table.id))
      if (saved && table.views.some((v) => v.id === saved)) return saved
    } catch {
      /* ignore */
    }
    return table.views[0]?.id
  })
  const changeView = (id: string) => {
    setViewId(id)
    try {
      localStorage.setItem(lastViewKey(table.id), id)
    } catch {
      /* ignore */
    }
    if (params.has('view')) setParams({}, { replace: true })
  }

  useEffect(() => {
    document.title = `${table.title.trim() || '未命名表格'} - 青简`
  }, [table.title])

  // flush pending edits when leaving; warn on tab close while saving
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (model.pending) {
        model.flush()
        e.preventDefault()
      }
    }
    // a hidden tab may be discarded without any unload event (mobile app switch)
    const onHide = () => {
      if (document.visibilityState === 'hidden') model.flush()
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      model.flush()
    }
  }, [model])

  const saveTitle = async () => {
    const t = title.trim()
    if (t === titleRef.current) return
    try {
      const n = await api.renameNode(table.id, t, { type: 'table', title: titleRef.current })
      titleRef.current = n.title
      model.setTitle(n.title)
      patchNode(table.id, { title: n.title })
    } catch (e: any) {
      toast(e.message)
    }
  }

  const active = table.views.find((v) => v.id === viewId) ?? table.views[0]
  const share = () => openShareDialog({ target_type: 'node', target_id: table.id, title: table.title || '未命名表格', views: table.views.map((v) => ({ id: v.id, name: v.name })) })

  const more = (el: HTMLElement) =>
    openMenu(el, [
      { label: '分享', icon: <IconShare />, onClick: share },
      {
        label: '导出当前视图 (Excel)',
        icon: <IconDownload />,
        onClick: () =>
          import('../table/xlsx')
            .then((m) => m.exportXLSX(model.data, active))
            .catch((e) => toast('导出失败：' + e.message)),
      },
      { label: '导出当前视图 (CSV)', icon: <IconDownload />, onClick: () => exportCSV(model.data, active) },
      {
        label: '导入 Excel / CSV',
        icon: <IconUpload />,
        onClick: async () => {
          const [file] = await pickFiles(false)
          if (!file) return
          const xlsx = /\.xlsx$/i.test(file.name)
          const run = xlsx ? import('../table/xlsx').then((m) => m.importXLSX(model, file, active.id)) : importCSV(model, file, active.id)
          run.catch((e) => toast('导入失败：' + (xlsx && /zip|central directory/i.test(e.message) ? '不是有效的 .xlsx 文件（旧版 .xls 请先另存为 .xlsx）' : e.message)))
        },
      },
      {
        label: '删除表格',
        icon: <IconTrash />,
        danger: true,
        divider: true,
        onClick: async () => {
          if (!(await confirmDialog('确定删除这个多维表格吗？可在回收站中恢复。', { danger: true, okText: '删除' }))) return
          await model.flush()
          await api.deleteNode(table.id)
          await loadTree(repoId)
          navigate(`/r/${repoId}`)
        },
      },
    ])

  const status = sync === 'saving' ? '保存中…' : sync === 'error' ? '保存失败' : `已保存 · ${formatTime(table.updated_at)}`

  return (
    <div className="page table-page">
      <PageHeader>
        <Crumbs>
          <Crumb to={`/r/${repoId}`} icon={repo && <RepoMark repo={repo} size={18} />}>
            {repo?.name}
          </Crumb>
          <input
            className="h-8 min-w-0 rounded-sm border border-transparent bg-transparent px-1.5 text-[13px] font-semibold text-ink transition-colors outline-none placeholder:text-ink-4 hover:bg-hover focus:border-line focus:bg-surface focus-visible:outline-none"
            value={title}
            aria-label="表格名称"
            placeholder="未命名表格"
            size={Math.max(6, Math.min(40, [...(title || '未命名表格')].length * 2))}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
          />
          <span className="ml-1 inline-flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-4" role="status">
            <span className={cn('size-1.5 rounded-full', sync === 'saving' ? 'animate-pulse bg-accent' : sync === 'error' ? 'bg-danger' : 'bg-success')} />
            <span className="max-sm:hidden">{status}</span>
          </span>
        </Crumbs>
        {backlinks.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            title="链接到这个表格的文档"
            icon={<IconLink width={14} height={14} />}
            onClick={(e) =>
              openPopover(
                e.currentTarget,
                (close) => (
                  <div className="p-3">
                    <div className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                      <IconLink width={14} height={14} className="text-ink-3" />
                      <span>反向链接</span>
                      <span className="tabular rounded-full bg-active px-1.5 py-px text-[11px] font-medium text-ink-3">{backlinks.length}</span>
                    </div>
                    <BacklinkList list={backlinks} repoId={repoId} onOpen={close} />
                  </div>
                ),
                { width: 380, align: 'right' },
              )
            }
          >
            {backlinks.length}
          </Button>
        )}
        <IconButton label="分享" className="max-md:hidden" onClick={share}>
          <IconShare width={16} height={16} />
        </IconButton>
        <IconButton label="更多" onClick={(e) => more(e.currentTarget)}>
          <IconMore width={16} height={16} />
        </IconButton>
      </PageHeader>
      <TableView model={model} readOnly={false} viewId={active?.id} onViewChange={changeView} />
    </div>
  )
}
