import { useEffect, useState } from 'react'
import { api, formatTime, type TrashItem } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconBook, IconDoc, IconFolder, IconRestore, IconTable, IconTrash } from '../components/icons'
import { Crumb, PageBody, PageTitle, RowIcon, RowList, rowClass } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Button, EmptyState, Loading } from '../components/ui'
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

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb>回收站</Crumb>
        </Crumbs>
      </PageHeader>
      <PageBody>
        <PageTitle sub="删除的内容会在这里保留 30 天，之后自动清除。">回收站</PageTitle>
        {!items ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState icon={<IconTrash />} title="回收站是空的">
            删除的文档、表格和知识库会先放在这里。
          </EmptyState>
        ) : (
          <RowList>
            {items.map((it) => (
              <div key={it.kind + it.id} className={rowClass + ' flex-wrap sm:flex-nowrap'}>
                <RowIcon accent={it.kind === 'repo'}>
                  {it.kind === 'repo' ? <IconBook /> : it.type === 'group' ? <IconFolder /> : it.type === 'table' ? <IconTable /> : <IconDoc />}
                </RowIcon>
                <span className="min-w-0 flex-1 truncate">{it.kind === 'repo' ? it.title : nodeTitle(it)}</span>
                <span className="max-w-32 shrink-0 truncate rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-3 max-sm:hidden">{it.kind === 'repo' ? '知识库' : it.repo_name}</span>
                <span className="tabular w-24 shrink-0 text-right text-[11.5px] text-ink-4 max-sm:hidden">{formatTime(it.deleted_at)}</span>
                <span className="flex shrink-0 gap-1.5 max-sm:w-full max-sm:justify-end max-sm:pl-10">
                  <Button size="sm" icon={<IconRestore width={13} height={13} />} onClick={() => restore(it)}>
                    恢复
                  </Button>
                  <Button size="sm" variant="danger-ghost" icon={<IconTrash width={13} height={13} />} onClick={() => purge(it)}>
                    删除
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
