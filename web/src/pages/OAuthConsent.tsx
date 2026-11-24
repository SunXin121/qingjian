import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { api, type MCPScope, type OAuthAuthorizeInfo } from '../api'
import { Logo } from '../components/icons'
import { Button, EmptyState, Loading, Switch } from '../components/ui'
import { setPageMeta } from '../seo'

const SCOPE_LABELS: { scope: MCPScope; label: string }[] = [
  { scope: 'mcp:read', label: '读取与检索（知识库、文档、多维表格）' },
  { scope: 'mcp:write', label: '创建与编辑（版本安全写入）' },
  { scope: 'mcp:trash', label: '回收站操作（移入回收站与恢复）' },
]

export default function OAuthConsent() {
  const location = useLocation()
  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null)
  const [scopes, setScopes] = useState<Set<MCPScope>>(new Set(['mcp:read']))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPageMeta({ title: 'MCP 客户端授权 - 青简' })
    api
      .oauthAuthorizeInfo(location.search)
      .then((r) => {
        setInfo(r)
        setScopes(new Set(r.requested_scopes))
      })
      .catch((e) => setError(e.message))
  }, [location.search])

  const toggleScope = (sc: MCPScope, on: boolean) => {
    const next = new Set(scopes)
    if (on) {
      next.add(sc)
      if (sc === 'mcp:write') next.add('mcp:read')
    } else {
      next.delete(sc)
      if (sc === 'mcp:read') next.delete('mcp:write')
    }
    if (next.size === 0) next.add('mcp:read')
    setScopes(next)
  }

  const submit = async (approve: boolean) => {
    if (!info) return
    const q = new URLSearchParams(location.search)
    setBusy(true)
    try {
      const res = await api.approveOAuth({
        approve,
        client_id: info.client_id,
        redirect_uri: info.redirect_uri,
        code_challenge: q.get('code_challenge') ?? '',
        code_challenge_method: q.get('code_challenge_method') ?? 'S256',
        state: q.get('state') ?? '',
        scopes: [...scopes],
      })
      window.location.href = res.redirect_to
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  if (error) {
    return (
      <main id="main-content" className="flex min-h-dvh items-center justify-center bg-base p-4">
        <EmptyState title="无法完成授权">{error}</EmptyState>
      </main>
    )
  }
  if (!info) return <Loading className="min-h-dvh" />

  return (
    <main id="main-content" className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-base p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(560px_420px_at_50%_28%,var(--accent-soft),transparent_70%)]" />
      <div className="relative flex w-full max-w-[400px] animate-rise flex-col rounded-2xl border border-line-subtle bg-surface p-6 shadow-modal sm:p-7">
        <div className="flex items-center gap-3">
          <Logo size={34} className="rounded-[9px]" />
          <div className="min-w-0">
            <h1 className="m-0 truncate text-[17px] font-semibold text-ink">授权「{info.client_name}」</h1>
            <div className="truncate font-mono text-[11.5px] text-ink-4">{new URL(info.redirect_uri).host || info.redirect_uri}</div>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-xl border border-line-subtle bg-editor">
          {SCOPE_LABELS.map(({ scope, label }) => (
            <div key={scope} className="flex items-center justify-between gap-3 border-b border-line-subtle px-3.5 py-3 text-[13px] last:border-b-0">
              <span className="text-ink">{label}</span>
              <Switch label={label} checked={scopes.has(scope)} disabled={busy} onChange={(v) => toggleScope(scope, v)} />
            </div>
          ))}
        </div>

        <div className="mt-5 flex gap-2.5">
          <Button block disabled={busy} onClick={() => submit(false)}>
            拒绝
          </Button>
          <Button variant="primary" block loading={busy} onClick={() => submit(true)}>
            允许访问
          </Button>
        </div>
      </div>
    </main>
  )
}
