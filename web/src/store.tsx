import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { api, type Repo, type TreeNode } from './api'

interface Store {
  repos: Repo[]
  loadRepos: () => Promise<void>
  tree: TreeNode[]
  treeRepoId: string | null
  loadTree: (repoId: string) => Promise<void>
  patchNode: (id: string, patch: Partial<TreeNode>) => void
  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void
  searchOpen: boolean
  setSearchOpen: (v: boolean) => void
}

const Ctx = createContext<Store>(null!)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeRepoId, setTreeRepoId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const loadRepos = useCallback(async () => setRepos(await api.repos()), [])
  const loadTree = useCallback(async (repoId: string) => {
    const nodes = await api.tree(repoId)
    setTreeRepoId(repoId)
    setTree(nodes)
  }, [])
  const patchNode = useCallback((id: string, patch: Partial<TreeNode>) => {
    setTree((t) => t.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  const value = useMemo(
    () => ({ repos, loadRepos, tree, treeRepoId, loadTree, patchNode, sidebarOpen, setSidebarOpen, searchOpen, setSearchOpen }),
    [repos, loadRepos, tree, treeRepoId, loadTree, patchNode, sidebarOpen, searchOpen],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useStore = () => useContext(Ctx)

export function childrenMap(nodes: TreeNode[]) {
  const map = new Map<string | null, TreeNode[]>()
  for (const n of nodes) {
    const k = n.parent_id
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(n)
  }
  for (const list of map.values()) list.sort((a, b) => a.sort - b.sort || a.created_at - b.created_at)
  return map
}

export const untitled = (t: string) => t.trim() || '无标题文档'
