import { useEffect, useState } from 'react'
import { api, formatTime, type TrashItem } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconBook, IconDoc, IconFolder, IconRestore, IconTable, IconTrash } from '../components/icons'
import { Crumb, PageBody, PageTitle, RowIcon, RowList, rowClass } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Badge, Button, EmptyState, Loading } from '../components/ui'
import { nodeTitle, useStore } from '../store'

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
  const emptyAll = async () => {
    if (!items?.length) return
    if (!(await confirmDialog(`彻底删除回收站中的全部 ${items.length} 项？此操作不可撤销。`, { danger: true, okText: '清空回收站' }))) return
    await api.emptyTrash()
    toast('回收站已清空')
    load()
  }

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb to="/">首页</Crumb>
          <Crumb current>回收站</Crumb>
        </Crumbs>
      </PageHeader>
      <PageBody>
        <PageTitle
          action={
            !!items?.length && (
              <Button variant="danger-ghost" icon={<IconTrash width={14} height={14} />} onClick={emptyAll}>
                清空回收站
              </Button>
            )
          }
        >
          回收站
        </PageTitle>
        {!items ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState icon={<IconTrash />} title="回收站是空的" />
        ) : (
          <RowList>
            {items.map((it) => (
              <div key={it.kind + it.id} className={rowClass + ' flex-wrap sm:flex-nowrap'}>
                <RowIcon accent={it.kind === 'repo'}>
                  {it.kind === 'repo' ? <IconBook /> : it.type === 'group' ? <IconFolder /> : it.type === 'table' ? <IconTable /> : <IconDoc />}
                </RowIcon>
                <span className="min-w-0 flex-1 truncate font-medium">{it.kind === 'repo' ? it.title || '未命名知识库' : nodeTitle(it)}</span>
                <Badge tone={it.kind === 'repo' ? 'accent' : 'neutral'} className="max-sm:hidden">
                  {it.kind === 'repo' ? '知识库' : it.repo_name}
                </Badge>
                <span className="tabular w-24 shrink-0 text-right text-[11.5px] text-ink-4 max-sm:hidden">{formatTime(it.deleted_at)}</span>
                <span className="flex shrink-0 gap-1.5 max-sm:w-full max-sm:justify-end max-sm:pl-11">
                  <Button size="sm" icon={<IconRestore width={13} height={13} />} onClick={() => restore(it)}>
                    恢复
                  </Button>
                  <Button size="sm" variant="danger-ghost" icon={<IconTrash width={13} height={13} />} onClick={() => purge(it)}>
                    彻底删除
                  </Button>
                </span>
              </div>
            ))}
          </RowList>
        )}
      </PageBody>
    </div>
  )
}
