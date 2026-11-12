import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, formatTime, nodePath, shareURL, type Share } from '../api'
import { confirmDialog, copyText, openMenu, toast } from '../components/dialog'
import { IconBook, IconCopy, IconDoc, IconEye, IconFolder, IconLink, IconLock, IconMore, IconSettings, IconTable, IconTrash, IconUnlink } from '../components/icons'
import { Crumb, PageBody, PageTitle, RowIcon, RowList, rowClass } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Badge, EmptyState, IconButton, Loading, type Tone } from '../components/ui'
import { formatExpiry, openShareDialog, shareState } from '../components/ShareDialog'
import { nodeTitle } from '../store'

export default function Shares() {
  const [list, setList] = useState<Share[] | null>(null)
  const load = useCallback(() => api.shares().then(setList).catch((e) => toast(e.message)), [])
  useEffect(() => {
    load()
  }, [load])

  const menu = (el: HTMLElement, sh: Share) =>
    openMenu(el, [
      { label: '复制链接', icon: <IconCopy />, onClick: () => copyText(shareURL(sh.token), '链接已复制') },
      {
        label: '管理',
        icon: <IconSettings />,
        hidden: !sh.target_alive,
        onClick: async () => {
          const views = sh.node_type === 'table' ? (await api.table(sh.target_id).catch(() => null))?.views.map((v) => ({ id: v.id, name: v.name })) : undefined
          openShareDialog({ target_type: sh.target_type, target_id: sh.target_id, node_type: sh.node_type, title: shareTitle(sh), views }, load)
        },
      },
      {
        label: sh.enabled ? '关闭链接' : '开启链接',
        icon: sh.enabled ? <IconUnlink /> : <IconLink />,
        hidden: !sh.target_alive,
        onClick: () =>
          api
            .updateShare(sh.token, { enabled: !sh.enabled })
            .then(load)
            .catch((e) => toast(e.message)),
      },
      {
        label: '删除分享',
        icon: <IconTrash />,
        danger: true,
        divider: true,
        onClick: async () => {
          if (!(await confirmDialog(`删除「${shareTitle(sh)}」的分享链接？链接将永久失效。`, { danger: true, okText: '删除' }))) return
          await api.deleteShare(sh.token)
          load()
        },
      },
    ])

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb>分享管理</Crumb>
        </Crumbs>
      </PageHeader>
      <PageBody>
        <PageTitle sub="所有对外公开的只读链接。在文档页右上角、目录中分组的菜单或知识库菜单中可以创建分享。">分享管理</PageTitle>
        {!list ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState icon={<IconLink />} title="还没有分享任何内容">
            分享后，任何拿到链接的人都能只读访问。
          </EmptyState>
        ) : (
          <RowList>
            {list.map((sh) => {
              const st = shareState(sh)
              const target =
                sh.target_type === 'repo' ? `/r/${sh.target_id}` : sh.node_type === 'group' ? `/r/${sh.repo_id}` : nodePath({ id: sh.target_id, repo_id: sh.repo_id, type: sh.node_type })
              return (
                <div key={sh.token} className={rowClass + ' py-2.5'}>
                  <RowIcon accent={sh.target_type === 'repo'}>{sh.target_type === 'repo' ? <IconBook /> : sh.node_type === 'table' ? <IconTable /> : sh.node_type === 'group' ? <IconFolder /> : <IconDoc />}</RowIcon>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {sh.target_alive ? (
                        <Link to={target} className="truncate font-medium text-ink hover:text-accent">
                          {shareTitle(sh)}
                        </Link>
                      ) : (
                        <span className="truncate text-ink-3">{shareTitle(sh)}</span>
                      )}
                      {sh.has_password && <IconLock width={13} height={13} className="shrink-0 text-ink-4" aria-label="有密码" />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-4">
                      <Badge tone={SHARE_TONE[st.cls] ?? 'neutral'}>{st.text}</Badge>
                      <span>{sh.target_type === 'repo' ? '知识库' : sh.repo_name}</span>
                      <span>{formatExpiry(sh)}</span>
                      <span className="tabular inline-flex items-center gap-1">
                        <IconEye width={12} height={12} /> {sh.view_count}
                      </span>
                      <span className="max-sm:hidden">创建于 {formatTime(sh.created_at)}</span>
                    </div>
                  </div>
                  <IconButton label="操作" onClick={(e) => menu(e.currentTarget, sh)}>
                    <IconMore width={16} height={16} />
                  </IconButton>
                </div>
              )
            })}
          </RowList>
        )}
      </PageBody>
    </div>
  )
}

const SHARE_TONE: Record<string, Tone> = { on: 'accent', off: 'neutral', warn: 'warn' }

function shareTitle(sh: Share) {
  return sh.target_type === 'repo' ? sh.title || '未命名知识库' : nodeTitle({ type: sh.node_type, title: sh.title })
}
