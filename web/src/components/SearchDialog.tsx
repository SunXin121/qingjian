import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { api, formatTime, nodePath, type SearchHit } from '../api'
import { nodeTitle, useStore, useStoreUI } from '../store'
import { isDark, setThemeMode } from '../theme'
import {
  IconBot,
  IconDoc,
  IconDocPlus,
  IconHome,
  IconKeyboard,
  IconLibrary,
  IconMoon,
  IconSearch,
  IconSettings,
  IconShare,
  IconSidebar,
  IconSun,
  IconTable,
  IconTrash,
} from './icons'
import { openShortcutsDialog } from './ShortcutsDialog'
import { cn, Kbd, Spinner } from './ui'

interface Command {
  id: string
  label: string
  icon: ReactNode
  keywords: string
  shortcut?: string[]
  run: () => void
}

type Item = { kind: 'cmd'; cmd: Command } | { kind: 'hit'; hit: SearchHit }

function Snippet({ text }: { text: string }) {
  // \x01 … \x02 mark highlighted ranges (from FTS5 snippet())
  const parts = text.replace(/\s+/g, ' ').split(/(\x01[^\x02]*\x02)/)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\x01') ? (
          <mark key={i} className="rounded-[3px] bg-accent-soft px-0.5 text-accent">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

export default function SearchDialog() {
  const { setSearchOpen, toggleSidebarCollapsed, loadTree, repos } = useStore()
  const { searchOpen, sidebarCollapsed } = useStoreUI()
  const repoMatch = useMatch('/r/:repoId/*')
  const activeRepoId = repoMatch?.params.repoId
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [recent, setRecent] = useState<SearchHit[]>([])
  const [sel, setSel] = useState(0)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  useEffect(() => {
    if (!searchOpen) return
    setSel(0)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    api.recent().then((r) => setRecent(r.slice(0, 8).map((d) => ({ ...d, snippet: '' })))).catch(() => {})
  }, [searchOpen])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    setLoading(true)
    let stale = false
    const t = setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (stale) return
          setHits(r)
          setSel(0)
        })
        .catch(() => !stale && setHits([]))
        .finally(() => !stale && setLoading(false))
    }, 180)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [q])

  useEffect(() => {
    listRef.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const commands = useMemo<Command[]>(() => {
    const nav = (path: string) => () => {
      setSearchOpen(false)
      navigate(path)
    }
    const targetRepo = repos.find((r) => r.id === activeRepoId) ?? repos[0]
    const contextual: Command[] = targetRepo
      ? [
          {
            id: 'new-doc',
            label: `在「${targetRepo.name}」新建文档`,
            icon: <IconDocPlus />,
            keywords: 'new create doc 新建 文档 笔记',
            run: async () => {
              setSearchOpen(false)
              const n = await api.createNode(targetRepo.id, null, 'doc')
              await loadTree(targetRepo.id)
              navigate(nodePath(n))
            },
          },
          {
            id: 'new-table',
            label: `在「${targetRepo.name}」新建多维表格`,
            icon: <IconTable />,
            keywords: 'new create table bitable 新建 表格 多维表格',
            run: async () => {
              setSearchOpen(false)
              const n = await api.createNode(targetRepo.id, null, 'table', '未命名表格')
              await loadTree(targetRepo.id)
              navigate(nodePath(n))
            },
          },
        ]
      : []

    return [
      ...contextual,
      { id: 'home', label: '前往首页', icon: <IconHome />, keywords: 'home shouye 首页', run: nav('/') },
      {
        id: 'sidebar',
        label: sidebarCollapsed ? '展开左侧边栏' : '收起左侧边栏（专注模式）',
        icon: <IconSidebar />,
        keywords: 'sidebar focus zen 侧边栏 专注 折叠 展开',
        shortcut: ['Ctrl', '\\'],
        run: () => {
          toggleSidebarCollapsed()
          setSearchOpen(false)
        },
      },
      {
        id: 'theme',
        label: isDark() ? '切换到浅色模式' : '切换到深色模式',
        icon: isDark() ? <IconSun /> : <IconMoon />,
        keywords: 'theme dark light 主题 深色 浅色 夜间',
        run: () => {
          setThemeMode(isDark() ? 'light' : 'dark')
          setSearchOpen(false)
        },
      },
      { id: 'settings', label: '打开设置', icon: <IconSettings />, keywords: 'settings shezhi 设置 外观 主题 排版', run: nav('/settings') },
      { id: 'mcp', label: 'MCP 服务与密钥', icon: <IconBot />, keywords: 'mcp oauth key token agent 模型上下文 授权 密钥', run: nav('/settings?tab=mcp') },
      {
        id: 'shortcuts',
        label: '查看键盘快捷键帮助',
        icon: <IconKeyboard />,
        keywords: 'shortcuts help keys 快捷键 帮助 键盘',
        shortcut: ['?'],
        run: () => {
          setSearchOpen(false)
          openShortcutsDialog()
        },
      },
      { id: 'shares', label: '分享管理', icon: <IconShare />, keywords: 'share fenxiang 分享 链接 seo', run: nav('/shares') },
      { id: 'trash', label: '回收站', icon: <IconTrash />, keywords: 'trash huishouzhan 回收站 删除', run: nav('/trash') },
      ...repos.map((r) => ({ id: 'repo:' + r.id, label: `打开知识库：${r.name}`, icon: <IconLibrary />, keywords: 'repo 知识库 ' + r.name, run: nav(`/r/${r.id}`) })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, activeRepoId, sidebarCollapsed, navigate, setSearchOpen, toggleSidebarCollapsed, loadTree, searchOpen])

  if (!searchOpen) return null
  const query = q.trim().toLowerCase()
  const cmds = query ? commands.filter((c) => (c.label + ' ' + c.keywords).toLowerCase().includes(query)).slice(0, 7) : commands.slice(0, 6)
  const docs = query ? hits : recent
  const items: Item[] = [...docs.map((hit) => ({ kind: 'hit' as const, hit })), ...cmds.map((cmd) => ({ kind: 'cmd' as const, cmd }))]
  const go = (it: Item) => {
    if (it.kind === 'cmd') return it.cmd.run()
    setSearchOpen(false)
    navigate(nodePath(it.hit))
  }
  const row = (it: Item, i: number) => {
    const on = i === sel
    const cls = cn(
      'flex w-full items-center gap-3 rounded-lg px-3 text-left transition-colors duration-(--dur-fast)',
      on ? 'bg-accent-soft' : 'hover:bg-hover',
    )
    if (it.kind === 'cmd')
      return (
        <button key={it.cmd.id} type="button" data-sel={on || undefined} className={cn(cls, 'h-10 md:h-9')} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
          <span className={cn('flex shrink-0 [&_svg]:size-[15px]', on ? 'text-accent' : 'text-ink-3')}>{it.cmd.icon}</span>
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', on ? 'font-medium text-accent' : 'text-ink')}>{it.cmd.label}</span>
          {it.cmd.shortcut && <Kbd keys={it.cmd.shortcut} className="max-sm:hidden" />}
        </button>
      )
    const h = it.hit
    if (!h.snippet)
      return (
        <button key={h.id} type="button" data-sel={on || undefined} className={cn(cls, 'h-10 md:h-9')} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
          <span className={cn('flex shrink-0 [&_svg]:size-[15px]', on ? 'text-accent' : 'text-ink-3')}>{h.type === 'table' ? <IconTable /> : <IconDoc />}</span>
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', on ? 'font-medium text-accent' : 'text-ink')}>{nodeTitle(h)}</span>
          <span className="max-w-28 shrink-0 truncate rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-3 max-sm:hidden">{h.repo_name}</span>
          <span className="tabular w-20 shrink-0 text-right text-[11px] text-ink-4">{formatTime(h.updated_at)}</span>
        </button>
      )
    return (
      <button key={h.id} type="button" data-sel={on || undefined} className={cn(cls, 'items-start py-2.5')} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
        <span className={cn('mt-0.5 shrink-0 [&_svg]:size-[15px]', on ? 'text-accent' : 'text-ink-3')}>{h.type === 'table' ? <IconTable /> : <IconDoc />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', on ? 'text-accent' : 'text-ink')}>{nodeTitle(h)}</span>
            <span className="max-w-28 shrink-0 truncate rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-3 max-sm:hidden">{h.repo_name}</span>
            <span className="tabular shrink-0 text-[11px] text-ink-4">{formatTime(h.updated_at)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-ink-3">
            <Snippet text={h.snippet} />
          </span>
        </span>
      </button>
    )
  }

  return (
    <div
      data-modal
      className="fixed inset-0 z-[200] flex animate-fade justify-center bg-scrim sm:items-start sm:px-4 sm:pt-[11vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setSearchOpen(false)}
    >
      <div
        className="flex w-full animate-modal flex-col overflow-hidden bg-overlay pt-(--safe-t) shadow-modal sm:max-h-[72vh] sm:max-w-[640px] sm:rounded-2xl sm:pt-0"
        role="dialog"
        aria-modal="true"
        aria-label="搜索与命令面板"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-4">
          {loading ? <Spinner size={16} className="text-ink-3" /> : <IconSearch width={17} height={17} className="shrink-0 text-ink-3" />}
          <input
            ref={inputRef}
            autoFocus
            value={q}
            placeholder="搜索文档、多维表格，或输入命令…"
            aria-label="搜索关键词或命令"
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4 focus-visible:outline-none max-sm:text-[16px]"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchOpen(false)
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, Math.max(0, items.length - 1)))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter' && items[sel] && !e.nativeEvent.isComposing) go(items[sel])
            }}
          />
          <Kbd keys={['Esc']} className="max-sm:hidden" />
          <button type="button" className="h-8 shrink-0 rounded-md px-2 text-[13px] text-ink-2 sm:hidden" onClick={() => setSearchOpen(false)}>
            取消
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5 max-sm:pb-(--safe-b)" ref={listRef}>
          {docs.length > 0 && <GroupLabel>{query ? '文档与多维表格' : '最近编辑'}</GroupLabel>}
          {docs.map((_, i) => row(items[i], i))}
          {query && !loading && hits.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">没有找到匹配的文档或表格</div>}
          {cmds.length > 0 && <GroupLabel>快捷命令</GroupLabel>}
          {cmds.map((_, j) => row(items[docs.length + j], docs.length + j))}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line-subtle bg-sunken/40 px-4 text-[11.5px] text-ink-4 max-sm:hidden">
          <span className="flex items-center gap-1.5">
            <Kbd keys={['↑', '↓']} /> 选择
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={['↵']} /> 执行 / 打开
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={['Esc']} /> 关闭
          </span>
        </div>
      </div>
    </div>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-ink-4 uppercase">{children}</div>
}
