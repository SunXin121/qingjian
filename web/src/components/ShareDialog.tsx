import { useEffect, useState } from 'react'
import { api, formatTime, shareURL, type Share } from '../api'
import { confirmDialog, copyText, Modal, mount, toast } from './dialog'

export interface ShareTarget {
  target_type: 'node' | 'repo'
  target_id: string
  title: string
  /** tables: the views a link may be restricted to */
  views?: { id: string; name: string }[]
}

type Preset = 'never' | '1' | '7' | '30' | 'custom' | ''

const DAY = 86_400_000

function presetExpiry(p: Preset, custom: string): number | null {
  if (p === 'never' || p === '') return null
  if (p === 'custom') {
    if (!custom) return null
    const d = new Date(custom + 'T23:59:59')
    return d.getTime()
  }
  return Date.now() + Number(p) * DAY
}

export function formatExpiry(sh: Pick<Share, 'expires_at'>) {
  if (!sh.expires_at) return '永久有效'
  const d = new Date(sh.expires_at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sh.expires_at <= Date.now() ? `已于 ${s} 过期` : `有效期至 ${s}`
}

export function shareState(sh: Share): { text: string; cls: string } {
  if (!sh.target_alive) return { text: '内容已删除', cls: 'off' }
  if (!sh.enabled) return { text: '已关闭', cls: 'off' }
  if (sh.expires_at && sh.expires_at <= Date.now()) return { text: '已过期', cls: 'warn' }
  return { text: '公开中', cls: 'on' }
}

function ExpiryPicker({ value, custom, onChange }: { value: Preset; custom: string; onChange: (p: Preset, custom: string) => void }) {
  const today = new Date()
  const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return (
    <div className="share-expiry">
      <select value={value} onChange={(e) => onChange(e.target.value as Preset, custom)}>
        {value === '' && (
          <option value="" disabled>
            修改有效期…
          </option>
        )}
        <option value="never">永久有效</option>
        <option value="1">1 天</option>
        <option value="7">7 天</option>
        <option value="30">30 天</option>
        <option value="custom">自定义日期</option>
      </select>
      {value === 'custom' && <input type="date" min={min} value={custom} onChange={(e) => onChange('custom', e.target.value)} />}
    </div>
  )
}

function ShareDialog({ target, onClose, onChanged }: { target: ShareTarget; onClose: () => void; onChanged?: () => void }) {
  const [share, setShare] = useState<Share | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // creation form / editing state
  const [password, setPassword] = useState('')
  const [preset, setPreset] = useState<Preset>('never')
  const [custom, setCustom] = useState('')
  const [editingPw, setEditingPw] = useState(false)
  const [editPreset, setEditPreset] = useState<Preset>('')
  const [lastPw, setLastPw] = useState('') // plain password known only right after setting it
  const [viewId, setViewId] = useState('')

  useEffect(() => {
    api
      .shares({ target_type: target.target_type, target_id: target.target_id })
      .then((l) => setShare(l[0] ?? null))
      .catch((e) => {
        toast(e.message)
        onClose()
      })
  }, [target.target_type, target.target_id, onClose])

  const run = async (fn: () => Promise<Share | null | void>) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r !== undefined) setShare(r)
      onChanged?.()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }

  const create = () =>
    run(async () => {
      if (preset === 'custom' && !custom) throw new Error('请选择到期日期')
      const sh = await api.createShare({
        target_type: target.target_type,
        target_id: target.target_id,
        password: password || undefined,
        expires_at: presetExpiry(preset, custom),
        view_id: viewId || null,
      })
      setLastPw(password)
      setPassword('')
      return sh
    })

  const kind = target.target_type === 'repo' ? '知识库' : target.views ? '表格' : '文档'
  const viewPicker = (value: string, onChange: (v: string) => void) => (
    <select className="share-view-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">全部视图</option>
      {target.views!.map((v) => (
        <option key={v.id} value={v.id}>
          仅「{v.name}」
        </option>
      ))}
    </select>
  )

  let body
  if (share === undefined) {
    body = <div className="modal-body muted">加载中…</div>
  } else if (share === null) {
    body = (
      <>
        <div className="modal-body form">
          <p className="muted share-intro">
            创建链接后，任何拿到链接的人都可以<strong>只读</strong>访问这个{kind}
            {target.target_type === 'repo' ? '（含目录中的全部文档）' : ''}。
          </p>
          {target.views && (
            <label className="field">
              <span>可见范围</span>
              {viewPicker(viewId, setViewId)}
            </label>
          )}
          <label className="field">
            <span>访问密码（可选）</span>
            <input value={password} placeholder="留空则无需密码" autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>有效期</span>
            <ExpiryPicker
              value={preset}
              custom={custom}
              onChange={(p, c) => {
                setPreset(p)
                setCustom(c)
              }}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={create}>
            创建分享链接
          </button>
        </div>
      </>
    )
  } else {
    const url = shareURL(share.token)
    const st = shareState(share)
    body = (
      <>
        <div className="modal-body form">
          <div className="share-link">
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn primary" onClick={() => copyText(lastPw ? `${url}\n访问密码：${lastPw}` : url, lastPw ? '已复制链接和密码' : '链接已复制')}>
              {lastPw ? '复制链接和密码' : '复制链接'}
            </button>
          </div>
          <div className="share-meta">
            <span className={'share-badge ' + st.cls}>{st.text}</span>
            <span>{formatExpiry(share)}</span>
            <span>访问 {share.view_count} 次</span>
            <a href={url} target="_blank" rel="noreferrer">
              打开
            </a>
          </div>

          <div className="share-row">
            <div>
              <div className="share-row-title">允许访问</div>
              <div className="share-row-desc">关闭后链接立即失效，可随时重新开启</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={share.enabled} disabled={busy} onChange={(e) => run(() => api.updateShare(share.token, { enabled: e.target.checked }))} />
              <span />
            </label>
          </div>

          {target.views && (
            <div className="share-row">
              <div>
                <div className="share-row-title">可见范围</div>
                <div className="share-row-desc">访客可以切换的视图</div>
              </div>
              {viewPicker(share.view_id ?? '', (v) => run(() => api.updateShare(share.token, { view_id: v || null })))}
            </div>
          )}

          <div className="share-row">
            <div>
              <div className="share-row-title">访问密码</div>
              <div className="share-row-desc">{share.has_password ? '已设置，访客需输入密码' : '未设置，拿到链接即可访问'}</div>
            </div>
            {!editingPw && (
              <div className="share-row-actions">
                <button className="btn sm" onClick={() => setEditingPw(true)}>
                  {share.has_password ? '修改' : '设置'}
                </button>
                {share.has_password && (
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setLastPw('')
                        return api.updateShare(share.token, { password: '' })
                      })
                    }
                  >
                    移除
                  </button>
                )}
              </div>
            )}
          </div>
          {editingPw && (
            <form
              className="share-pw-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (!password) return
                run(async () => {
                  const sh = await api.updateShare(share.token, { password })
                  setLastPw(password)
                  setPassword('')
                  setEditingPw(false)
                  toast('密码已更新，已登录的访客需重新输入')
                  return sh
                })
              }}
            >
              <input autoFocus value={password} placeholder="新密码" autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="btn sm" onClick={() => setEditingPw(false)}>
                取消
              </button>
              <button className="btn sm primary" disabled={!password || busy}>
                保存
              </button>
            </form>
          )}

          <div className="share-row">
            <div>
              <div className="share-row-title">有效期</div>
              <div className="share-row-desc">{formatExpiry(share)}</div>
            </div>
            <ExpiryPicker
              value={editPreset}
              custom={custom}
              onChange={(p, c) => {
                setCustom(c)
                if (p === 'custom' && !c) return setEditPreset('custom')
                setEditPreset('')
                run(() => api.updateShare(share.token, { expires_at: presetExpiry(p, c) }))
              }}
            />
          </div>
          <div className="share-foot-meta muted">创建于 {formatTime(share.created_at)}</div>
        </div>
        <div className="modal-actions spread">
          <span className="modal-actions-left">
            <button
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                if (!(await confirmDialog('重新生成后，旧链接将立即失效。继续吗？', { okText: '重新生成' }))) return
                run(() => api.regenerateShare(share.token))
              }}
            >
              重新生成链接
            </button>
            <button
              className="btn sm danger outline"
              disabled={busy}
              onClick={async () => {
                if (!(await confirmDialog('删除后链接将永久失效。确定删除这个分享吗？', { danger: true, okText: '删除' }))) return
                run(async () => {
                  await api.deleteShare(share.token)
                  setLastPw('')
                  return null
                })
              }}
            >
              删除分享
            </button>
          </span>
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </div>
      </>
    )
  }

  return (
    <Modal title={`分享${kind}「${target.title}」`} onClose={onClose}>
      {body}
    </Modal>
  )
}

export function openShareDialog(target: ShareTarget, onChanged?: () => void) {
  mount((close) => <ShareDialog target={target} onClose={close} onChanged={onChanged} />)
}
