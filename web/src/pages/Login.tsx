import { useEffect, useState } from 'react'
import { api } from '../api'
import { IconEye, IconEyeOff, Logo } from '../components/icons'
import { Button, Input } from '../components/ui'
import { setPageMeta } from '../seo'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPageMeta({ title: '登录 - 青简' })
  }, [])

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
    <main id="main-content" className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-base p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(620px_460px_at_50%_26%,var(--accent-soft),transparent_72%)]" />
      <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(var(--border-subtle)_1px,transparent_1px),linear-gradient(90deg,var(--border-subtle)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(640px_480px_at_50%_38%,#000_18%,transparent_75%)]" />

      <form
        aria-label="管理员登录"
        className="relative flex w-full max-w-[360px] animate-rise flex-col items-center rounded-2xl border border-line-subtle bg-[color-mix(in_oklab,var(--bg-surface)_88%,transparent)] px-6 py-8 shadow-modal backdrop-blur-md sm:px-8"
        onSubmit={submit}
      >
        <span className="grid size-15 place-items-center rounded-[17px] border border-line-subtle bg-surface shadow-card">
          <Logo size={36} className="rounded-[9px]" />
        </span>
        <h1 className="mt-4 mb-6 font-serif text-[27px] font-bold tracking-[0.14em] text-ink">青简</h1>

        <div className="relative w-full">
          <Input
            type={showPw ? 'text' : 'password'}
            autoFocus
            autoComplete="current-password"
            placeholder="管理密码"
            aria-label="管理密码"
            className="h-11 pr-10 text-[14px] md:h-10"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <button
            type="button"
            aria-label={showPw ? '隐藏密码' : '显示密码'}
            tabIndex={-1}
            className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-4 transition-colors hover:bg-hover hover:text-ink-2"
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? <IconEyeOff width={15} height={15} /> : <IconEye width={15} height={15} />}
          </button>
        </div>

        {err && (
          <div role="alert" className="mt-2.5 w-full rounded-md bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-1.5 text-[12.5px] text-danger">
            {err}
          </div>
        )}

        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pw} className="mt-3.5">
          {busy ? '登录中…' : '进入'}
        </Button>
      </form>
    </main>
  )
}
