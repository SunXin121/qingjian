import { useState } from 'react'
import { api } from '../api'
import { IconLock, Logo } from '../components/icons'
import { Button, Input } from '../components/ui'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api.login(pw)
      onLogin()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-base p-4">
      {/* a warm glow of the accent and a faint paper grid, fading out from the centre */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(560px_420px_at_50%_30%,var(--accent-soft),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(var(--border-subtle)_1px,transparent_1px),linear-gradient(90deg,var(--border-subtle)_1px,transparent_1px)] [background-size:52px_52px] [mask-image:radial-gradient(640px_460px_at_50%_40%,#000_20%,transparent_75%)]" />
      <form className="relative flex w-full max-w-[360px] animate-rise flex-col items-center gap-3" onSubmit={submit}>
        <span className="grid size-16 place-items-center rounded-[18px] border border-line-subtle bg-surface shadow-card">
          <Logo size={38} className="rounded-[10px]" />
        </span>
        <h1 className="mt-3 mb-0 font-serif text-[28px] font-bold tracking-[0.14em] text-ink">青简</h1>
        <p className="mt-0 mb-4 text-[13px] text-ink-3">落笔成简，安放每一条想法</p>
        <Input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="管理密码"
          aria-label="管理密码"
          className="h-11 bg-[color-mix(in_oklab,var(--bg-surface)_80%,transparent)] text-[14px] md:h-10"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && <div className="self-start text-[12.5px] text-danger">{err}</div>}
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pw}>
          {busy ? '登录中…' : '进入'}
        </Button>
        <div className="mt-5 flex items-center gap-1.5 text-[12px] text-ink-4">
          <IconLock width={12} height={12} /> 私有知识库 · 数据由你掌控
        </div>
      </form>
    </div>
  )
}
