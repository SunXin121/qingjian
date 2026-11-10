import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, NavLink, useMatch, useNavigate } from 'react-router'
import { api, nodePath, type NodeType, type TreeNode } from '../api'
import { childrenMap, nodeTitle, useStore } from '../store'
import { confirmDialog, openMenu, promptText, toast } from './dialog'
import { editRepoDialog } from './RepoDialog'
import { useWindowed } from './useWindowed'
import {
  IconBack,
  IconChevron,
  IconDoc,
  IconDocPlus,
  IconDown,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconHome,
  IconIndent,
  IconLogout,
  IconMore,
  IconOutdent,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShare,
  IconTable,
  IconTrash,
  IconUp,
  Logo,
  RepoMark,
} from './icons'

const EXPAND_KEY = 'qj.expanded'
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export default function Sidebar() {
  const { repos, loadRepos, setSidebarOpen, setSearchOpen } = useStore()
  const repoMatch = useMatch('/r/:repoId/*')
  const repoId = repoMatch?.params.repoId
  const navigate = useNavigate()

  useEffect(() => {
    loadRepos().catch(() => {})
  }, [loadRepos])

  const logout = async () => {
    await api.logout()
    location.href = '/login'
  }

  const newRepo = async () => {
    const value = await editRepoDialog()
    if (!value) return
    const r = await api.createRepo(value.name, value.description, value.icon)
    await loadRepos()
    navigate(`/r/${r.id}`)
  }

  return (
    <aside className="sidebar" onClick={(e) => (e.target as Element).closest('a') && setSidebarOpen(false)}>
      <div className="sidebar-head">
        <Link to="/" className="brand">
          <Logo size={26} />
          <span className="brand-name">青简</span>
        </Link>
      </div>
      <button className="search-trigger" onClick={() => setSearchOpen(true)}>
        <IconSearch width={16} height={16} />
        <span>搜索文档</span>
        <kbd>Ctrl K</kbd>
      </button>

      {repoId ? (
        <RepoTree repoId={repoId} />
      ) : (
        <>
          <nav className="side-nav">
            <NavLink to="/" end className="side-link">
              <IconHome /> 首页
            </NavLink>
            <NavLink to="/shares" className="side-link">
              <IconShare /> 分享管理
            </NavLink>
            <NavLink to="/trash" className="side-link">
              <IconTrash /> 回收站
            </NavLink>
          </nav>
          <div className="side-section">
            <span>知识库</span>
            <button className="icon-btn" title="新建知识库" onClick={newRepo}>
              <IconPlus width={15} height={15} />
            </button>
          </div>
          <div className="side-scroll">
            {repos.map((r) => (
              <NavLink key={r.id} to={`/r/${r.id}`} className="side-link">
                <RepoMark repo={r} className="side-dot" /> <span className="ellipsis">{r.name}</span>
                <span className="side-count">{r.doc_count || ''}</span>
              </NavLink>
            ))}
            {repos.length === 0 && (
              <button className="side-empty-btn" onClick={newRepo}>
                <IconPlus width={15} height={15} /> 新建第一个知识库
              </button>
            )}
          </div>
        </>
      )}

      <div className="sidebar-foot">
        <NavLink to="/settings" className="sidebar-settings" title="设置">
          <IconSettings width={17} height={17} />
          <span>设置</span>
        </NavLink>
        <button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={logout}>
          <IconLogout width={17} height={17} />
        </button>
      </div>
    </aside>
  )
}

type DropPos = 'before' | 'after' | 'inside'

function RepoTree({ repoId }: { repoId: string }) {
  const { repos, tree, treeRepoId, loadTree, setSidebarOpen } = useStore()
  const navigate = useNavigate()
  const docMatch = useMatch('/r/:repoId/d/:docId')
  const tableMatch = useMatch('/r/:repoId/t/:tableId')
  const activeId = docMatch?.params.docId ?? tableMatch?.params.tableId
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [drag, setDrag] = useState<{ id: string; over?: string; pos?: DropPos } | null>(null)
  const repo = repos.find((r) => r.id === repoId)

  useEffect(() => {
    loadTree(repoId).catch((e) => toast(e.message))
  }, [repoId, loadTree])

  const nodes = treeRepoId === repoId ? tree : []
  const kids = useMemo(() => childrenMap(nodes), [nodes])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // make sure the active doc is visible
  useEffect(() => {
    if (!activeId) return
    let cur = byId.get(activeId)
    const add: string[] = []
    while (cur?.parent_id) {
      add.push(cur.parent_id)
      cur = byId.get(cur.parent_id)
    }
    if (add.some((id) => !expanded.has(id))) setExpandedPersist(new Set([...expanded, ...add]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, byId])

  function setExpandedPersist(s: Set<string>) {
    setExpanded(s)
    try {
      localStorage.setItem(EXPAND_KEY, JSON.stringify([...s].slice(-500)))
    } catch {
      /* ignore */
    }
  }
  const toggle = (id: string) => {
    const s = new Set(expanded)
    s.has(id) ? s.delete(id) : s.add(id)
    setExpandedPersist(s)
  }

  const create = async (parent: string | null, type: NodeType) => {
    let title = ''
    if (type === 'group') {
      const t = await promptText('新建分组', '', '分组名称')
      if (!t) return
      title = t
    }
    if (type === 'table') title = '未命名表格'
    const n = await api.createNode(repoId, parent, type, title)
    if (parent) setExpandedPersist(new Set([...expanded, parent]))
    await loadTree(repoId)
    if (type !== 'group') {
      navigate(nodePath(n))
      setSidebarOpen(false)
    }
  }

  const move = async (node: TreeNode, parent: string | null, sort: number) => {
    try {
      await api.moveNode(node.id, parent, sort)
      if (parent) setExpandedPersist(new Set([...expanded, parent]))
    } catch (e: any) {
      toast(e.message)
    }
    await loadTree(repoId)
  }

  /** compute parent + sort for dropping `node` relative to `target` */
  const placement = (target: TreeNode, pos: DropPos): [string | null, number] => {
    if (pos === 'inside') {
      const list = kids.get(target.id) ?? []
      return [target.id, (list.at(-1)?.sort ?? 0) + 1]
    }
    const siblings = kids.get(target.parent_id) ?? []
    const i = siblings.findIndex((s) => s.id === target.id)
    if (pos === 'before') {
      const prev = siblings[i - 1]
      return [target.parent_id, prev ? (prev.sort + target.sort) / 2 : target.sort - 1]
    }
    const next = siblings[i + 1]
    return [target.parent_id, next ? (target.sort + next.sort) / 2 : target.sort + 1]
  }

  const nodeMenu = (el: HTMLElement, n: TreeNode) => {
    const siblings = kids.get(n.parent_id) ?? []
    const i = siblings.findIndex((s) => s.id === n.id)
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined
    openMenu(el, [
      { label: '新建子文档', icon: <IconDocPlus />, onClick: () => create(n.id, 'doc') },
      { label: '新建子分组', icon: <IconFolderPlus />, onClick: () => create(n.id, 'group') },
      { label: '新建子多维表格', icon: <IconTable />, onClick: () => create(n.id, 'table') },
      {
        label: '重命名',
        icon: <IconEdit />,
        divider: true,
        onClick: async () => {
          const t = await promptText('重命名', n.title)
          if (t === null) return
          await api.renameNode(n.id, t, { type: n.type, title: n.title })
          await loadTree(repoId)
        },
      },
      { label: '上移', icon: <IconUp />, hidden: i <= 0, onClick: () => move(n, ...placement(siblings[i - 1], 'before')) },
      { label: '下移', icon: <IconDown />, hidden: i >= siblings.length - 1, onClick: () => move(n, ...placement(siblings[i + 1], 'after')) },
      { label: '移入上一项', icon: <IconIndent />, hidden: i <= 0, onClick: () => move(n, ...placement(siblings[i - 1], 'inside')) },
      { label: '移出到上一级', icon: <IconOutdent />, hidden: !parent, onClick: () => parent && move(n, ...placement(parent, 'after')) },
      {
        label: '删除',
        icon: <IconTrash />,
        danger: true,
        divider: true,
        onClick: async () => {
          const hasKids = (kids.get(n.id) ?? []).length > 0
          const ok = await confirmDialog(`确定删除「${nodeTitle(n)}」${hasKids ? '及其所有子节点' : ''}吗？可在回收站中恢复。`, { danger: true, okText: '删除' })
          if (!ok) return
          await api.deleteNode(n.id)
          await loadTree(repoId)
          if (activeId && (activeId === n.id || isDescendant(byId, activeId, n.id))) navigate(`/r/${repoId}`)
        },
      },
    ])
  }

  const onDragOver = (e: DragEvent, n: TreeNode) => {
    if (!drag || drag.id === n.id) return
    if (isDescendant(byId, n.id, drag.id)) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    const pos: DropPos = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside'
    if (drag.over !== n.id || drag.pos !== pos) setDrag({ ...drag, over: n.id, pos })
  }
  const onDrop = (e: DragEvent, n: TreeNode) => {
    e.preventDefault()
    if (!drag?.pos || drag.id === n.id) return setDrag(null)
    const node = byId.get(drag.id)
    const pos = drag.pos
    setDrag(null)
    if (node) move(node, ...placement(n, pos))
  }

  // the visible (expanded) part of the tree as a flat list, rendered windowed: a repo can
  // hold thousands of documents
  const flat = useMemo(() => {
    const out: { n: TreeNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        out.push({ n, depth })
        if (expanded.has(n.id)) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [kids, expanded])
  const win = useWindowed<HTMLDivElement>(flat.length, 33)

  const renderRow = ({ n, depth }: { n: TreeNode; depth: number }) => {
    const children = kids.get(n.id) ?? []
    const open = expanded.has(n.id)
    const cls = ['tree-item', n.id === activeId && 'active', drag?.over === n.id && `drop-${drag.pos}`, drag?.id === n.id && 'dragging'].filter(Boolean).join(' ')
    return (
      <div
        key={n.id}
        data-row
        className={cls}
        style={{ paddingLeft: 8 + depth * 16 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', n.id)
          setDrag({ id: n.id })
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => onDragOver(e, n)}
        onDrop={(e) => onDrop(e, n)}
        onClick={() => {
          if (n.type === 'group') toggle(n.id)
          else {
            navigate(nodePath(n))
            setSidebarOpen(false)
          }
        }}
      >
        <button
          className={'tree-toggle' + (open ? ' open' : '') + (children.length ? '' : ' invisible')}
          onClick={(e) => {
            e.stopPropagation()
            toggle(n.id)
          }}
        >
          <IconChevron width={14} height={14} />
        </button>
        {n.type === 'group' ? open ? <IconFolderOpen className="tree-icon" /> : <IconFolder className="tree-icon" /> : n.type === 'table' ? <IconTable className="tree-icon" /> : <IconDoc className="tree-icon" />}
        <span className="tree-title">{nodeTitle(n)}</span>
        <span className="tree-actions">
          <button
            className="icon-btn sm"
            title="新建子文档"
            onClick={(e) => {
              e.stopPropagation()
              create(n.id, 'doc')
            }}
          >
            <IconPlus width={15} height={15} />
          </button>
          <button
            className="icon-btn sm"
            title="更多"
            onClick={(e) => {
              e.stopPropagation()
              nodeMenu(e.currentTarget, n)
            }}
          >
            <IconMore width={15} height={15} />
          </button>
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="repo-head">
        <Link to="/" className="icon-btn" title="返回首页">
          <IconBack width={17} height={17} />
        </Link>
        <Link to={`/r/${repoId}`} className="repo-name">
          {repo && <RepoMark repo={repo} className="side-dot" />}
          <span>{repo?.name ?? '知识库'}</span>
        </Link>
        <button
          className="icon-btn"
          title="新建"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: '新建文档', icon: <IconDocPlus />, onClick: () => create(null, 'doc') },
              { label: '新建分组', icon: <IconFolderPlus />, onClick: () => create(null, 'group') },
              { label: '新建多维表格', icon: <IconTable />, onClick: () => create(null, 'table') },
            ])
          }
        >
          <IconPlus />
        </button>
      </div>
      <div className="side-scroll tree">
        <div ref={win.listRef}>
          <div style={{ height: win.before }} />
          {flat.slice(win.start, win.end).map(renderRow)}
          <div style={{ height: win.after }} />
        </div>
        {nodes.length === 0 && (
          <div className="side-empty">
            <button className="btn" onClick={() => create(null, 'doc')}>
              <IconDocPlus width={16} height={16} /> 新建第一篇文档
            </button>
          </div>
        )}
        {/* drop zone to move items to the end of root */}
        <div
          className="tree-tail"
          onDragOver={(e) => drag && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const node = drag && byId.get(drag.id)
            setDrag(null)
            const root = kids.get(null) ?? []
            if (node) move(node, null, (root.at(-1)?.sort ?? 0) + 1)
          }}
        />
      </div>
    </>
  )
}

function isDescendant(byId: Map<string, TreeNode>, id: string, ancestor: string) {
  let cur = byId.get(id)
  while (cur?.parent_id) {
    if (cur.parent_id === ancestor) return true
    cur = byId.get(cur.parent_id)
  }
  return false
}
