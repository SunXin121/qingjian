import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, NavLink, useMatch, useNavigate } from 'react-router'
import { Scissors } from 'lucide-react'
import { api, nodePath, type NodeType, type TreeNode } from '../api'
import { childrenMap, nodeTitle, useStore } from '../store'
import { confirmDialog, openMenu, promptText, toast, type MenuItem } from './dialog'
import { canPickFolder, droppedEntries, isFileDrag, pickImport, runImport } from './ImportDialog'
import { editRepoDialog, repoMenu } from './RepoDialog'
import { openShareDialog } from './ShareDialog'
import { Caption, cn, IconButton, Kbd } from './ui'
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
  const { repos, loadRepos, sidebarOpen, setSidebarOpen, setSearchOpen } = useStore()
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
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 flex w-(--side-w) flex-col border-r border-line-subtle bg-sunken pt-(--safe-t)',
        'max-md:w-[min(300px,84vw)] max-md:-translate-x-full max-md:transition-transform max-md:duration-(--dur-base) max-md:ease-out',
        sidebarOpen && 'max-md:translate-x-0 max-md:shadow-modal',
      )}
      onClick={(e) => (e.target as Element).closest('a') && setSidebarOpen(false)}
    >
      <div className="flex h-12 shrink-0 items-center px-3">
        <Link to="/" className="-ml-1 flex items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors duration-(--dur-fast) hover:bg-hover">
          <Logo size={24} className="shadow-[0_1px_2px_rgb(0_0_0/0.12)] rounded-[7px]" />
          <span className="font-serif text-[17px] font-bold tracking-[0.08em] text-ink">青简</span>
        </Link>
      </div>
      <button
        className="group mx-2.5 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-md border border-line-subtle bg-[color-mix(in_oklab,var(--bg-surface)_70%,transparent)] px-2.5 text-[12.5px] text-ink-4 transition-[border-color,color,background-color] duration-(--dur-fast) hover:border-line hover:bg-surface hover:text-ink-3 md:h-8"
        onClick={() => setSearchOpen(true)}
      >
        <IconSearch width={14} height={14} />
        <span className="flex-1 text-left">搜索</span>
        <Kbd keys={['Ctrl', 'K']} className="max-md:hidden" />
      </button>

      {repoId ? (
        <RepoTree repoId={repoId} />
      ) : (
        <>
          <nav className="flex flex-col gap-px px-2">
            <SideLink to="/" end icon={<IconHome />}>
              首页
            </SideLink>
            <SideLink to="/clip" icon={<Scissors />}>
              网页剪藏
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
            {repos.map((r) => (
              <SideLink key={r.id} to={`/r/${r.id}`} icon={<RepoMark repo={r} size={18} />} count={r.doc_count || undefined}>
                {r.name}
              </SideLink>
            ))}
            {repos.length === 0 && (
              <button
                className="flex h-9 w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-[12.5px] text-ink-3 transition-colors duration-(--dur-fast) hover:border-accent hover:text-accent"
                onClick={newRepo}
              >
                <IconPlus width={14} height={14} /> 新建第一个知识库
              </button>
            )}
          </div>
        </>
      )}

      <div className="flex shrink-0 items-center gap-1 border-t border-line-subtle px-2 pt-2 pb-[calc(8px+var(--safe-b))]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex h-9 flex-1 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-(--dur-fast) md:h-8',
              isActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
            )
          }
        >
          <IconSettings width={16} height={16} className="opacity-80" />
          <span>设置</span>
        </NavLink>
        <IconButton label="退出登录" onClick={logout}>
          <IconLogout width={16} height={16} />
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

function RepoTree({ repoId }: { repoId: string }) {
  const { repos, tree, treeRepoId, loadTree, loadRepos, setSidebarOpen } = useStore()
  const navigate = useNavigate()
  const docMatch = useMatch('/r/:repoId/d/:docId')
  const tableMatch = useMatch('/r/:repoId/t/:tableId')
  const activeId = docMatch?.params.docId ?? tableMatch?.params.tableId
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [drag, setDrag] = useState<{ id: string; over?: string; pos?: DropPos } | null>(null)
  // files dragged in from the desktop: false = none, null = the root, else the node to import into
  const [fileDrop, setFileDrop] = useState<string | null | false>(false)
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
  // dropping desktop files on a table imports next to it
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
    const active = n.id === activeId
    const dropInside = (drag?.over === n.id && drag.pos === 'inside') || fileDrop === n.id
    const Icon = n.type === 'group' ? (open ? IconFolderOpen : IconFolder) : n.type === 'table' ? IconTable : IconDoc
    return (
      <div
        key={n.id}
        data-row
        className={cn(
          'group relative mb-px flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[13px] select-none touch:h-10',
          'transition-colors duration-(--dur-fast)',
          active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink',
          dropInside && 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]',
          drag?.id === n.id && 'opacity-40',
          drag?.over === n.id && drag.pos === 'before' && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-accent',
          drag?.over === n.id && drag.pos === 'after' && 'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
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
        <span className="hidden shrink-0 gap-px group-hover:flex touch:flex">
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
            label="更多"
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
        <Link to="/" className="grid size-9 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink md:size-7" title="返回首页" aria-label="返回首页">
          <IconBack width={16} height={16} />
        </Link>
        <Link to={`/r/${repoId}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] font-semibold text-ink transition-colors hover:bg-hover">
          {repo && <RepoMark repo={repo} size={20} />}
          <span className="truncate">{repo?.name ?? '知识库'}</span>
        </Link>
        <IconButton
          label="新建"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: '新建文档', icon: <IconDocPlus />, onClick: () => create(null, 'doc') },
              { label: '新建分组', icon: <IconFolderPlus />, onClick: () => create(null, 'group') },
              { label: '新建多维表格', icon: <IconTable />, onClick: () => create(null, 'table') },
            ])
          }
        >
          <IconPlus width={16} height={16} />
        </IconButton>
        {repo && (
          <IconButton
            label="知识库设置"
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
            <IconMore width={16} height={16} />
          </IconButton>
        )}
      </div>
      <div
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
          <div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12.5px] font-medium text-ink shadow-sm transition-colors hover:bg-hover"
              onClick={() => create(null, 'doc')}
            >
              <IconDocPlus width={15} height={15} /> 新建第一篇文档
            </button>
            <p className="m-0 text-[11.5px] leading-relaxed text-ink-4">也可以从「···」菜单导入 Markdown，或把文件、文件夹拖到这里</p>
          </div>
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
}

function isDescendant(byId: Map<string, TreeNode>, id: string, ancestor: string) {
  let cur = byId.get(id)
  while (cur?.parent_id) {
    if (cur.parent_id === ancestor) return true
    cur = byId.get(cur.parent_id)
  }
  return false
}
