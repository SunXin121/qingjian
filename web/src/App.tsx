import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, authEvents } from './api'
import SearchDialog from './components/SearchDialog'
import Sidebar from './components/Sidebar'
import Home from './pages/Home'
import Login from './pages/Login'
import RepoHome from './pages/RepoHome'
import Trash from './pages/Trash'
import { StoreProvider, useStore } from './store'

const DocPage = lazy(() => import('./pages/DocPage'))
const TablePage = lazy(() => import('./pages/TablePage'))
const SharePage = lazy(() => import('./pages/SharePage'))
const Shares = lazy(() => import('./pages/Shares'))
const Settings = lazy(() => import('./pages/Settings'))

function Shell() {
  const { sidebarOpen, setSidebarOpen } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => setSidebarOpen(false), [location.pathname, setSidebarOpen])
  // in-app links rendered outside React (e.g. table embeds inside the editor)
  useEffect(() => {
    const onNav = (e: Event) => navigate((e as CustomEvent<string>).detail)
    import('./table/embed').then((m) => m.resetEmbedSource())
    window.addEventListener('qj-nav', onNav)
    return () => window.removeEventListener('qj-nav', onNav)
  }, [navigate])
  return (
    <div className={'shell' + (sidebarOpen ? ' sidebar-open' : '')}>
      <Sidebar />
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <div className="content">
        <Suspense fallback={<div className="ink-loading">加载中…</div>}>
          <Outlet />
        </Suspense>
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
            <Suspense fallback={<div className="ink-loading">加载中…</div>}>
              <SharePage />
            </Suspense>
          }
        />
        <Route path="*" element={<AuthGate />} />
      </Routes>
    </BrowserRouter>
  )
}
