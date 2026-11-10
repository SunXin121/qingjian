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

function Shell() {
  const { sidebarOpen, setSidebarOpen } = useStore()
  const location = useLocation()
  useEffect(() => setSidebarOpen(false), [location.pathname, setSidebarOpen])
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
          <Route path="r/:repoId" element={<RepoHome />} />
          <Route path="r/:repoId/d/:docId" element={<DocPage />} />
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
        <Route path="*" element={<AuthGate />} />
      </Routes>
    </BrowserRouter>
  )
}
