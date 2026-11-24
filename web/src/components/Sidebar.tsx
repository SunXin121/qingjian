import { memo, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, NavLink, useMatch, useNavigate } from 'react-router'
import { api, nodePath, type NodeType, type TreeNode } from '../api'
import { childrenMap, nodeTitle, useStore, useStoreUI } from '../store'
import { isDark, onThemeModeChange, setThemeMode } from '../theme'
import { confirmDialog, openMenu, promptText, toast, type MenuItem } from './dialog'
import { canPickFolder, droppedEntries, isFileDrag, pickImport, runImport } from './ImportDialog'
import { editRepoDialog, repoMenu } from './RepoDialog'
import { openShareDialog } from './ShareDialog'
import { openShortcutsDialog } from './ShortcutsDialog'
import { Caption, cn, IconButton, Kbd } from './ui'
import { useWindowed } from './useWindowed'
import {
  IconChevron,
  IconChevronsUpDown,
  IconClose,
  IconDoc,
  IconDocPlus,
  IconDown,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconHome,
  IconIndent,
  IconKeyboard,
  IconLogout,
  IconMoon,
  IconMore,
  IconOutdent,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShare,
  IconSidebarClose,
  IconSun,
  IconTable,
  IconTrash,
  IconUp,
  IconUpload,
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
  const { repos, loadRepos, setSidebarOpen, setSidebarCollapsed, setSearchOpen } = useStore()
  const { sidebarOpen, sidebarCollapsed } = useStoreUI()
  const repoMatch = useMatch('/r/:repoId/*')
  const repoId = repoMatch?.params.repoId
  const navigate = useNavigate()
  const [dark, setDark] = useState(isDark)

  useEffect(() => {
    loadRepos().catch(() => {})
  }, [loadRepos])

  useEffect(() => onThemeModeChange(() => setDark(isDark())), [])

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

  const toggleTheme = () => {
    const next = isDark() ? 'light' : 'dark'
    setThemeMode(next)
    setDark(next === 'dark')
  }

  return (
    <aside
      aria-label="主导航侧边栏"
      className={cn(
        'fixed inset-y-0 left-0 z-30 flex w-(--side-w) flex-col border-r border-line-subtle bg-sunken pt-(--safe-t)',
        'transition-transform duration-(--dur-base) ease-out',
        'max-md:w-[min(300px,84vw)] max-md:-translate-x-full',
        sidebarOpen && 'max-md:translate-x-0 max-md:shadow-modal',
        sidebarCollapsed && 'md:-translate-x-full',
      )}
      onClick={(e) => (e.target as Element).closest('a') && setSidebarOpen(false)}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <Link to="/" className="-ml-1 flex items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors duration-(--dur-fast) hover:bg-hover">
          <Logo size={24} className="rounded-[7px] shadow-[0_1px_2px_rgb(0_0_0/0.12)]" />
          <span className="font-serif text-[17px] font-bold tracking-[0.08em] text-ink">青简</span>
        </Link>
        <IconButton label="收起侧边栏 (Ctrl+\\)" size="sm" className="max-md:hidden" onClick={() => setSidebarCollapsed(true)}>
          <IconSidebarClose width={15} height={15} />
        </IconButton>
      </div>

      <button
        type="button"
        aria-label="全文搜索与命令面板 (Ctrl+K)"
        data-agent-action="open-search"
        className="group mx-2.5 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line-subtle bg-[color-mix(in_oklab,var(--bg-surface)_76%,transparent)] px-2.5 text-[12.5px] text-ink-3 shadow-[0_1px_1px_rgb(0_0_0/0.02)] transition-[border-color,color,background-color,box-shadow] duration-(--dur-fast) hover:border-line hover:bg-surface hover:text-ink md:h-8"
        onClick={() => setSearchOpen(true)}
      >
        <IconSearch width={14} height={14} className="text-ink-4 transition-colors group-hover:text-ink-2" />
        <span className="flex-1 text-left">搜索 / 命令</span>
        <Kbd keys={['Ctrl', 'K']} className="max-md:hidden" />
      </button>

      {repoId ? (
        <RepoTree repoId={repoId} onNewRepo={newRepo} />
      ) : (
        <>
          <nav aria-label="全局页面" className="flex flex-col gap-0.5 px-2">
            <SideLink to="/" end icon={<IconHome />}>
              首页
            </SideLink>
            <SideLink to="/shares" icon={<IconShare />}>
              分享管理
            </SideLink>
            <SideLink to="/trash" icon={<IconTrash />}>
              回收站
            </SideLink>
          </nav>
          <Caption
            className="mt-4 px-4"
            action={
              <IconButton label="新建知识库" size="sm" onClick={newRepo} className="-mr-1">
                <IconPlus width={14} height={14} />
              </IconButton>
            }
          >
            知识库
          </Caption>
          <nav aria-label="知识库列表" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
            {repos.map((r) => (
              <SideLink key={r.id} to={`/r/${r.id}`} icon={<RepoMark repo={r} size={18} />} count={r.doc_count || undefined}>
                {r.name}
              </SideLink>
            ))}
            {repos.length === 0 && (
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-[12.5px] text-ink-3 transition-colors duration-(--dur-fast) hover:border-accent hover:text-accent"
                onClick={newRepo}
              >
                <IconPlus width={14} height={14} /> 新建第一个知识库
              </button>
            )}
          </nav>
        </>
      )}

      <div className="flex shrink-0 items-center gap-0.5 border-t border-line-subtle px-2 pt-2 pb-[calc(8px+var(--safe-b))]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex h-9 flex-1 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-(--dur-fast) md:h-8',
              isActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
            )
          }
        >
          <IconSettings width={15} height={15} className="opacity-85" />
          <span>设置</span>
        </NavLink>
        <IconButton label={dark ? '切换到浅色模式' : '切换到深色模式'} size="sm" onClick={toggleTheme}>
          {dark ? <IconSun width={15} height={15} /> : <IconMoon width={15} height={15} />}
        </IconButton>
        <IconButton label="键盘快捷键 (?)" size="sm" className="max-md:hidden" onClick={openShortcutsDialog}>
          <IconKeyboard width={15} height={15} />
        </IconButton>
        <IconButton label="退出登录" size="sm" onClick={logout}>
          <IconLogout width={15} height={15} />
        </IconButton>
      </div>
    </aside>
  )
}

/** A navigation row in the sidebar. */
function SideLink({ to, end, icon, count, children }: { to: string; end?: boolean; icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-(--dur-fast) md:h-8 touch:h-10',
          '[&>svg]:size-4 [&>svg]:shrink-0',
          isActive ? 'bg-accent-soft font-medium text-accent [&>svg]:text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink [&>svg]:text-ink-3',
        )
      }
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="tabular shrink-0 pl-1.5 text-[11.5px] text-ink-4 group-[.active]:text-accent/70">{count}</span>}
    </NavLink>
  )
}

type DropPos = 'before' | 'after' | 'inside'

const RepoTree = memo(function RepoTree({ repoId, onNewRepo }: { repoId: string; onNewRepo: () => void }) {
  const { repos, tree, treeRepoId, loadTree, loadRepos, setSidebarOpen } = useStore()
  const navigate = useNavigate()
  const docMatch = useMatch('/r/:repoId/d/:docId')
  const tableMatch = useMatch('/r/:repoId/t/:tableId')
  const activeId = docMatch?.params.docId ?? tableMatch?.params.tableId
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [filter, setFilter] = useState('')
  const [drag, setDrag] = useState<{ id: string; over?: string; pos?: DropPos } | null>(null)
  // files dragged in from the desktop: false = none, null = the root, else the node to import into
  const [fileDrop, setFileDrop] = useState<string | null | false>(false)
  const repo = repos.find((r) => r.id === repoId)

  useEffect(() => {
    setFilter('')
    loadTree(repoId).catch((e) => toast(e.message))
  }, [repoId, loadTree])

  const nodes = useMemo(() => (treeRepoId === repoId ? tree : []), [treeRepoId, repoId, tree])
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
    if (s.has(id)) s.delete(id)
    else s.add(id)
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

  const importInto = async (parent: string | null, picked: Awaited<ReturnType<typeof pickImport>>) => {
    if (!picked) return
    const res = await runImport(repoId, parent, picked)
    if (!res) return
    if (parent) setExpandedPersist(new Set([...expanded, parent]))
    await loadTree(repoId)
    loadRepos().catch(() => {})
    if (res.docs === 1 && res.first) {
      navigate(nodePath(res.first))
      setSidebarOpen(false)
    }
  }
  const importItems = (parent: string | null): MenuItem[] => [
    { label: '导入 Markdown / zip', icon: <IconUpload />, divider: true, onClick: async () => importInto(parent, await pickImport(false)) },
    { label: '导入文件夹', icon: <IconFolder />, hidden: !canPickFolder, onClick: async () => importInto(parent, await pickImport(true)) },
  ]
  const fileTarget = (n: TreeNode) => (n.type === 'table' ? n.parent_id : n.id)

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

  const openSwitcher = (el: HTMLElement) => {
    openMenu(
      el,
      [
        { label: '返回首页', icon: <IconHome />, onClick: () => navigate('/') },
        { label: '分享管理', icon: <IconShare />, onClick: () => navigate('/shares') },
        { label: '回收站', icon: <IconTrash />, onClick: () => navigate('/trash') },
        ...repos.map((r, idx) => ({
          label: r.name,
          icon: <RepoMark repo={r} size={16} />,
          divider: idx === 0,
          checked: r.id === repoId,
          onClick: () => navigate(`/r/${r.id}`),
        })),
        { label: '新建知识库…', icon: <IconPlus />, divider: true, onClick: onNewRepo },
      ],
      { align: 'left', width: 220 },
    )
  }

  const nodeMenu = (el: HTMLElement, n: TreeNode) => {
    const siblings = kids.get(n.parent_id) ?? []
    const i = siblings.findIndex((s) => s.id === n.id)
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined
    openMenu(el, [
      { label: '新建子文档', icon: <IconDocPlus />, onClick: () => create(n.id, 'doc') },
      { label: '新建子分组', icon: <IconFolderPlus />, onClick: () => create(n.id, 'group') },
      { label: '新建子多维表格', icon: <IconTable />, onClick: () => create(n.id, 'table') },
      ...importItems(n.id),
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
      {
        label: '分享分组',
        icon: <IconShare />,
        hidden: n.type !== 'group',
        onClick: () => openShareDialog({ target_type: 'node', target_id: n.id, node_type: 'group', title: nodeTitle(n) }),
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
    if (!drag && isFileDrag(e.dataTransfer)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      if (fileDrop !== fileTarget(n)) setFileDrop(fileTarget(n))
      return
    }
    if (!drag || drag.id === n.id) return
    if (isDescendant(byId, n.id, drag.id)) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    const pos: DropPos = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside'
    if (drag.over !== n.id || drag.pos !== pos) setDrag({ ...drag, over: n.id, pos })
  }
  const onFileDrop = (e: DragEvent, target: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    setFileDrop(false)
    droppedEntries(e.dataTransfer)
      .then((picked) => importInto(target, picked))
      .catch((err) => toast(err.message))
  }
  const onDrop = (e: DragEvent, n: TreeNode) => {
    if (!drag && isFileDrag(e.dataTransfer)) return onFileDrop(e, fileTarget(n))
    e.preventDefault()
    if (!drag?.pos || drag.id === n.id) return setDrag(null)
    const node = byId.get(drag.id)
    const pos = drag.pos
    setDrag(null)
    if (node) move(node, ...placement(n, pos))
  }

  const trimmedFilter = filter.trim().toLowerCase()
  const flat = useMemo(() => {
    if (trimmedFilter) {
      // When filtering, include matching nodes and their ancestors so hierarchy stays clear
      const keep = new Set<string>()
      for (const n of nodes) {
        if (nodeTitle(n).toLowerCase().includes(trimmedFilter)) {
          let cur: TreeNode | undefined = n
          while (cur) {
            keep.add(cur.id)
            cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
          }
        }
      }
      const out: { n: TreeNode; depth: number }[] = []
      const walk = (parent: string | null, depth: number) => {
        for (const n of kids.get(parent) ?? []) {
          if (!keep.has(n.id)) continue
          out.push({ n, depth })
          walk(n.id, depth + 1)
        }
      }
      walk(null, 0)
      return out
    }
    const out: { n: TreeNode; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        out.push({ n, depth })
        if (expanded.has(n.id)) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [kids, expanded, trimmedFilter, nodes, byId])
  const win = useWindowed<HTMLDivElement>(flat.length, 33)

  const renderRow = ({ n, depth }: { n: TreeNode; depth: number }) => {
    const children = kids.get(n.id) ?? []
    const open = Boolean(trimmedFilter) || expanded.has(n.id)
    const active = n.id === activeId
    const dropInside = (drag?.over === n.id && drag.pos === 'inside') || fileDrop === n.id
    const Icon = n.type === 'group' ? (open ? IconFolderOpen : IconFolder) : n.type === 'table' ? IconTable : IconDoc
    const activate = () => {
      if (n.type === 'group') toggle(n.id)
      else {
        navigate(nodePath(n))
        setSidebarOpen(false)
      }
    }
    return (
      <div
        key={n.id}
        data-row
        data-node-id={n.id}
        data-node-type={n.type}
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={children.length > 0 ? open : undefined}
        aria-selected={active}
        className={cn(
          'group relative mb-px flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[13px] outline-none select-none touch:h-10',
          'transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-accent-ring',
          active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
          dropInside && 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]',
          drag?.id === n.id && 'opacity-40',
          drag?.over === n.id && drag.pos === 'before' && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-accent',
          drag?.over === n.id && drag.pos === 'after' && 'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
        draggable={!trimmedFilter}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', n.id)
          setDrag({ id: n.id })
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => onDragOver(e, n)}
        onDrop={(e) => onDrop(e, n)}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate()
          } else if (e.key === 'ArrowRight' && children.length > 0 && !open) {
            e.preventDefault()
            toggle(n.id)
          } else if (e.key === 'ArrowLeft' && children.length > 0 && open) {
            e.preventDefault()
            toggle(n.id)
          }
        }}
      >
        <button
          type="button"
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-[4px] text-ink-4 transition-[transform,background-color] duration-(--dur-fast) ease-out hover:bg-active hover:text-ink-2',
            open && 'rotate-90',
            !children.length && 'invisible',
          )}
          tabIndex={-1}
          aria-label={open ? '折叠' : '展开'}
          onClick={(e) => {
            e.stopPropagation()
            toggle(n.id)
          }}
        >
          <IconChevron width={13} height={13} />
        </button>
        <Icon width={15} height={15} className={cn('shrink-0', active ? 'text-accent' : 'text-ink-3')} />
        <span className="min-w-0 flex-1 truncate pl-1">{nodeTitle(n)}</span>
        <span className="hidden shrink-0 gap-px group-hover:flex group-focus-within:flex touch:flex">
          <IconButton
            label="新建子文档"
            size="sm"
            className="hover:bg-active"
            onClick={(e) => {
              e.stopPropagation()
              create(n.id, 'doc')
            }}
          >
            <IconPlus width={14} height={14} />
          </IconButton>
          <IconButton
            label="更多操作"
            size="sm"
            className="hover:bg-active"
            onClick={(e) => {
              e.stopPropagation()
              nodeMenu(e.currentTarget, n)
            }}
          >
            <IconMore width={14} height={14} />
          </IconButton>
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1.5">
        <Link
          to={`/r/${repoId}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] font-semibold text-ink transition-colors hover:bg-hover"
          title="知识库目录主页"
        >
          {repo && <RepoMark repo={repo} size={20} />}
          <span className="truncate">{repo?.name ?? '知识库'}</span>
        </Link>
        <IconButton label="切换知识库或返回首页" size="sm" onClick={(e) => openSwitcher(e.currentTarget)}>
          <IconChevronsUpDown width={14} height={14} />
        </IconButton>
        <IconButton
          label="新建内容"
          size="sm"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: '新建文档', icon: <IconDocPlus />, onClick: () => create(null, 'doc') },
              { label: '新建分组', icon: <IconFolderPlus />, onClick: () => create(null, 'group') },
              { label: '新建多维表格', icon: <IconTable />, onClick: () => create(null, 'table') },
            ])
          }
        >
          <IconPlus width={15} height={15} />
        </IconButton>
        {repo && (
          <IconButton
            label="知识库设置"
            size="sm"
            onClick={(e) =>
              repoMenu(
                e.currentTarget,
                repo,
                () => loadRepos().catch(() => {}),
                () => navigate('/'),
                (folder) => void pickImport(folder).then((picked) => importInto(null, picked)),
              )
            }
          >
            <IconMore width={15} height={15} />
          </IconButton>
        )}
      </div>

      {nodes.length > 6 && (
        <div className="mx-2.5 mb-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle bg-[color-mix(in_oklab,var(--bg-surface)_55%,transparent)] px-2 text-[12px] focus-within:border-line-strong focus-within:bg-surface">
          <IconSearch width={12} height={12} className="shrink-0 text-ink-4" />
          <input
            value={filter}
            aria-label="筛选目录"
            placeholder="筛选目录…"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4 focus-visible:outline-none"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          />
          {filter && (
            <button type="button" aria-label="清除筛选" className="grid size-4 place-items-center rounded-xs text-ink-4 hover:text-ink" onClick={() => setFilter('')}>
              <IconClose width={11} height={11} />
            </button>
          )}
        </div>
      )}

      <div
        role="tree"
        aria-label={`${repo?.name ?? '知识库'}目录树`}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2',
          fileDrop === null && 'rounded-md bg-accent-softer shadow-[inset_0_0_0_1px_var(--accent-ring)]',
        )}
        onDragOver={(e) => {
          if (drag || !isFileDrag(e.dataTransfer)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (fileDrop !== null) setFileDrop(null)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrop(false)
        }}
        onDrop={(e) => !drag && isFileDrag(e.dataTransfer) && onFileDrop(e, null)}
      >
        <div ref={win.listRef}>
          <div style={{ height: win.before }} />
          {flat.slice(win.start, win.end).map(renderRow)}
          <div style={{ height: win.after }} />
        </div>
        {nodes.length === 0 && (
          <div className="flex flex-col items-center px-3 py-6 text-center">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12.5px] font-medium text-ink shadow-sm transition-colors hover:bg-hover"
              onClick={() => create(null, 'doc')}
            >
              <IconDocPlus width={15} height={15} /> 新建第一篇文档
            </button>
          </div>
        )}
        {nodes.length > 0 && trimmedFilter && flat.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-ink-4">没有匹配的目录项</div>
        )}
        {/* drop zone to move items to the end of root */}
        <div
          className="h-10"
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
})

function isDescendant(byId: Map<string, TreeNode>, id: string, ancestor: string) {
  let cur = byId.get(id)
  while (cur?.parent_id) {
    if (cur.parent_id === ancestor) return true
    cur = byId.get(cur.parent_id)
  }
  return false
}
