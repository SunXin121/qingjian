import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, formatTime, nodePath, shareURL, type Share } from '../api'
import { confirmDialog, copyText, openMenu, toast } from '../components/dialog'
import { IconBook, IconCopy, IconDoc, IconEye, IconLink, IconLock, IconMore, IconSettings, IconTable, IconTrash, IconUnlink } from '../components/icons'
import PageHeader from '../components/PageHeader'
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
          openShareDialog({ target_type: sh.target_type, target_id: sh.target_id, title: shareTitle(sh), views }, load)
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
    <div className="page">
      <PageHeader>
        <span className="crumb">分享管理</span>
      </PageHeader>
      <div className="page-body">
        <h1 className="page-title">分享管理</h1>
        <p className="muted">所有对外公开的只读链接。在文档页右上角或知识库菜单中可以创建分享。</p>
        <div className="doc-list share-list">
          {list?.map((sh) => {
            const st = shareState(sh)
            const target = sh.target_type === 'repo' ? `/r/${sh.target_id}` : nodePath({ id: sh.target_id, repo_id: sh.repo_id, type: sh.node_type })
            return (
              <div key={sh.token} className="share-item">
                <span className={'doc-row-icon' + (sh.target_type === 'repo' ? ' repo' : '')}>
                  {sh.target_type === 'repo' ? <IconBook width={16} height={16} /> : sh.node_type === 'table' ? <IconTable width={16} height={16} /> : <IconDoc width={16} height={16} />}
                </span>
                <div className="share-item-main">
                  <div className="share-item-title">
                    {sh.target_alive ? (
                      <Link to={target} className="ellipsis">
                        {shareTitle(sh)}
                      </Link>
                    ) : (
                      <span className="ellipsis muted">{shareTitle(sh)}</span>
                    )}
                    {sh.has_password && <IconLock width={14} height={14} className="muted" aria-label="有密码" />}
                  </div>
                  <div className="share-item-meta">
                    <span className={'share-badge ' + st.cls}>{st.text}</span>
                    <span>{sh.target_type === 'repo' ? '知识库' : sh.repo_name}</span>
                    <span>{formatExpiry(sh)}</span>
                    <span className="meta-ico">
                      <IconEye width={13} height={13} /> {sh.view_count}
                    </span>
                    <span>创建于 {formatTime(sh.created_at)}</span>
                  </div>
                </div>
                <button className="icon-btn" title="操作" onClick={(e) => menu(e.currentTarget, sh)}>
                  <IconMore />
                </button>
              </div>
            )
          })}
          {list?.length === 0 && (
            <div className="empty-state small">
              <span className="empty-icon">
                <IconLink width={22} height={22} />
              </span>
              还没有分享任何内容
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function shareTitle(sh: Share) {
  return sh.target_type === 'repo' ? sh.title || '未命名知识库' : nodeTitle({ type: sh.node_type, title: sh.title })
}
