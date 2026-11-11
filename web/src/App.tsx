import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, authEvents } from './api'
import ErrorBoundary from './components/ErrorBoundary'
import SearchDialog from './components/SearchDialog'
import Sidebar from './components/Sidebar'
import Home from './pages/Home'
import Login from './pages/Login'
import RepoHome from './pages/RepoHome'
import Trash from './pages/Trash'
import { StoreProvider, useStore } from './store'

const loadDocPage = () => import('./pages/DocPage')
const loadTablePage = () => import('./pages/TablePage')
const DocPage = lazy(loadDocPage)
const TablePage = lazy(loadTablePage)
const SharePage = lazy(() => import('./pages/SharePage'))
const Shares = lazy(() => import('./pages/Shares'))
const Settings = lazy(() => import('./pages/Settings'))

/**
 * Fetch and evaluate the editor and table chunks while the app sits idle. Evaluating
 * them (and applying the editor's stylesheet) takes a long main-thread task; doing it
 * on the first click into a document froze the page right as it should transition.
 * One chunk per idle callback, so each blocks for as short a stretch as possible.
 */
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

function Shell() {
  const { sidebarOpen, setSidebarOpen, loadTree, treeRepoId } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => setSidebarOpen(false), [location.pathname, setSidebarOpen])
  // documents and tables name the tab themselves; every other page gets the app name back
  useEffect(() => {
    if (!/^\/r\/[^/]+\/[dt]\//.test(location.pathname)) document.title = '青简 Qingjian'
  }, [location.pathname])
  useEffect(preloadHeavyPages, [])
  // in-app links rendered outside React (e.g. table embeds inside the editor)
  useEffect(() => {
    const onNav = (e: Event) => navigate((e as CustomEvent<string>).detail)
    import('./table/embed').then((m) => m.resetEmbedSource())
    window.addEventListener('qj-nav', onNav)
    return () => window.removeEventListener('qj-nav', onNav)
  }, [navigate])
  // nodes created outside the sidebar (a new document from the [[ picker)
  useEffect(() => {
    const onTree = (e: Event) => {
      const repo = (e as CustomEvent<string>).detail
      if (repo === treeRepoId) loadTree(repo)
    }
    window.addEventListener('qj-tree-changed', onTree)
    return () => window.removeEventListener('qj-tree-changed', onTree)
  }, [loadTree, treeRepoId])
  return (
    <div className={'shell' + (sidebarOpen ? ' sidebar-open' : '')}>
      <Sidebar />
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <div className="content">
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<div className="ink-loading">加载中…</div>}>
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

  if (state === 'loading') return null
  if (location.pathname === '/login') {
    return state === 'in' ? (
      <Navigate to={new URLSearchParams(location.search).get('next') || '/'} replace />
    ) : (
      <Login
        onLogin={() => {
          setState('in')
          navigate(new URLSearchParams(location.search).get('next') || '/', { replace: true })
        }}
      />
    )
  }
  if (state === 'out') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  return (
    <StoreProvider>
      <Routes>
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
        {/* public share links live outside the admin session */}
        <Route
          path="s/:token/:docId?"
          element={
            <ErrorBoundary>
              <Suspense fallback={<div className="ink-loading">加载中…</div>}>
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
