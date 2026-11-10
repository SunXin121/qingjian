import { useState } from 'react'
import { api } from '../api'

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
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width="48" height="48" />
        <h1>青简</h1>
        <p className="muted">个人知识库</p>
        <input type="password" autoFocus autoComplete="current-password" placeholder="管理密码" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="login-error">{err}</div>}
        <button className="btn primary block" disabled={busy || !pw}>
          {busy ? '登录中…' : '进入'}
        </button>
      </form>
    </div>
  )
}
