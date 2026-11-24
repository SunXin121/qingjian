import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type Repo, type TreeNode } from './api'

const COLLAPSED_KEY = 'qj.sidebarCollapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

interface Store {
  repos: Repo[]
  loadRepos: () => Promise<void>
  tree: TreeNode[]
  treeRepoId: string | null
  loadTree: (repoId: string) => Promise<void>
  patchNode: (id: string, patch: Partial<TreeNode>) => void
  setSidebarOpen: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  toggleSidebarCollapsed: () => void
  setSearchOpen: (v: boolean) => void
}

const Ctx = createContext<Store>(null!)
const UICtx = createContext<{ sidebarOpen: boolean; sidebarCollapsed: boolean; searchOpen: boolean }>(null!)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeRepoId, setTreeRepoId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(loadCollapsed)
  const [searchOpen, setSearchOpen] = useState(false)
  const treeRequest = useRef(0)

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedState(v)
    try {
      if (v) localStorage.setItem(COLLAPSED_KEY, '1')
      else localStorage.removeItem(COLLAPSED_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsedState((prev) => {
      const next = !prev
      try {
        if (next) localStorage.setItem(COLLAPSED_KEY, '1')
        else localStorage.removeItem(COLLAPSED_KEY)
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const loadRepos = useCallback(async () => setRepos(await api.repos()), [])
  const loadTree = useCallback(async (repoId: string) => {
    const request = ++treeRequest.current
    const nodes = await api.tree(repoId)
    if (request !== treeRequest.current) return
    setTreeRepoId(repoId)
    setTree(nodes)
  }, [])
  const patchNode = useCallback((id: string, patch: Partial<TreeNode>) => {
    setTree((t) => t.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  const value = useMemo(
    () => ({
      repos,
      loadRepos,
      tree,
      treeRepoId,
      loadTree,
      patchNode,
      setSidebarOpen,
      setSidebarCollapsed,
      toggleSidebarCollapsed,
      setSearchOpen,
    }),
    [repos, loadRepos, tree, treeRepoId, loadTree, patchNode, setSidebarCollapsed, toggleSidebarCollapsed],
  )
  const ui = useMemo(() => ({ sidebarOpen, sidebarCollapsed, searchOpen }), [sidebarOpen, sidebarCollapsed, searchOpen])
  return (
    <Ctx.Provider value={value}>
      <UICtx.Provider value={ui}>{children}</UICtx.Provider>
    </Ctx.Provider>
  )
}

export const useStore = () => useContext(Ctx)
export const useStoreUI = () => useContext(UICtx)

export function childrenMap<T extends { parent_id: string | null; sort: number; created_at?: number }>(nodes: T[]) {
  const map = new Map<string | null, T[]>()
  for (const n of nodes) {
    const k = n.parent_id
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(n)
  }
  for (const list of map.values()) list.sort((a, b) => a.sort - b.sort || (a.created_at ?? 0) - (b.created_at ?? 0))
  return map
}

export const untitled = (t: string) => t.trim() || '无标题文档'

export function nodeTitle(n: { type: string; title: string }) {
  if (n.type === 'group') return n.title.trim() || '未命名分组'
  if (n.type === 'table') return n.title.trim() || '未命名表格'
  return untitled(n.title)
}
