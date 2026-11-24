import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, authEvents } from './api'
import ErrorBoundary from './components/ErrorBoundary'
import SearchDialog from './components/SearchDialog'
import { openShortcutsDialog } from './components/ShortcutsDialog'
import Sidebar from './components/Sidebar'
import { cn, Loading } from './components/ui'
import { onAppEvent } from './events'
import Home from './pages/Home'
import Login from './pages/Login'
import RepoHome from './pages/RepoHome'
import Trash from './pages/Trash'
import { setPageMeta } from './seo'
import { StoreProvider, useStore, useStoreUI } from './store'

const loadDocPage = () => import('./pages/DocPage')
const loadTablePage = () => import('./pages/TablePage')
const DocPage = lazy(loadDocPage)
const TablePage = lazy(loadTablePage)
const SharePage = lazy(() => import('./pages/SharePage'))
const Shares = lazy(() => import('./pages/Shares'))
const Settings = lazy(() => import('./pages/Settings'))
const OAuthConsent = lazy(() => import('./pages/OAuthConsent'))

function preloadHeavyPages() {
  const idle = (fn: () => void) =>
    'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1500)
  const queue = [loadDocPage, loadTablePage]
  const next = () => {
    const load = queue.shift()
    if (load) idle(() => load().then(next, next))
  }
  setTimeout(next, 800)
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .ProseMirror'))
}

function Shell() {
  const { setSidebarOpen, toggleSidebarCollapsed, loadTree, treeRepoId } = useStore()
  const { sidebarOpen, sidebarCollapsed } = useStoreUI()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => setSidebarOpen(false), [location.pathname, setSidebarOpen])

  useEffect(() => {
    const p = location.pathname
    if (p === '/') setPageMeta({ title: '首页 - 青简' })
    else if (p === '/shares') setPageMeta({ title: '分享管理 - 青简' })
    else if (p === '/trash') setPageMeta({ title: '回收站 - 青简' })
    else if (p === '/settings') setPageMeta({ title: '设置 - 青简' })
  }, [location.pathname])

  useEffect(preloadHeavyPages, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        if (window.matchMedia('(min-width: 768px)').matches) toggleSidebarCollapsed()
        else setSidebarOpen(!sidebarOpen)
        return
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target) || document.querySelector('[data-modal], .ink-board-modal')) return
        e.preventDefault()
        openShortcutsDialog()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebarCollapsed, setSidebarOpen, sidebarOpen])

  useEffect(() => {
    import('./table/embed').then((m) => m.resetEmbedSource())
    return onAppEvent('qj-nav', (path) => navigate(path))
  }, [navigate])

  useEffect(() => {
    return onAppEvent('qj-tree-changed', (repo) => {
      if (repo === treeRepoId) loadTree(repo)
    })
  }, [loadTree, treeRepoId])

  return (
    <div className="flex min-h-dvh bg-editor">
      <a href="#main-content" className="skip-link">
        跳转到主要内容
      </a>
      <Sidebar />
      <div
        className={cn('fixed inset-0 z-[25] hidden animate-fade bg-scrim md:hidden', sidebarOpen && 'block')}
        onClick={() => setSidebarOpen(false)}
      />
      <div className={cn('min-w-0 flex-1 transition-[margin] duration-(--dur-base) ease-out', !sidebarCollapsed && 'md:ml-(--side-w)')}>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </div>
      <SearchDialog />
    </div>
  )
}

function AuthGate() {
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading')
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    api
      .me()
      .then((r) => setState(r.admin ? 'in' : 'out'))
      .catch(() => setState('out'))
    const onUnauth = () => setState('out')
    authEvents.addEventListener('unauthorized', onUnauth)
    return () => authEvents.removeEventListener('unauthorized', onUnauth)
  }, [])

  if (state === 'loading') return <Loading className="min-h-dvh" />
  if (location.pathname === '/login') {
    const nextUrl = new URLSearchParams(location.search).get('next') || '/'
    return state === 'in' ? (
      <Navigate to={nextUrl} replace />
    ) : (
      <Login
        onLogin={() => {
          setState('in')
          navigate(nextUrl, { replace: true })
        }}
      />
    )
  }
  if (state === 'out') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return (
    <StoreProvider>
      <Routes>
        <Route
          path="oauth/authorize"
          element={
            <ErrorBoundary>
              <Suspense fallback={<Loading className="min-h-dvh" />}>
                <OAuthConsent />
              </Suspense>
            </ErrorBoundary>
          }
        />
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="trash" element={<Trash />} />
          <Route path="shares" element={<Shares />} />
          <Route path="settings" element={<Settings />} />
          <Route path="r/:repoId" element={<RepoHome />} />
          <Route path="r/:repoId/d/:docId" element={<DocPage />} />
          <Route path="r/:repoId/t/:tableId" element={<TablePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </StoreProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="s/:token/:docId?"
          element={
            <ErrorBoundary>
              <Suspense fallback={<Loading />}>
                <SharePage />
              </Suspense>
            </ErrorBoundary>
          }
        />
        <Route path="*" element={<AuthGate />} />
      </Routes>
    </BrowserRouter>
  )
}
