import { useEffect, useState } from 'react'
import { api, formatTime, shareURL, type Share } from '../api'
import type { ReactNode } from 'react'
import { confirmDialog, copyText, Modal, ModalActions, ModalBody, mount, toast } from './dialog'
import { Badge, Button, cn, inputClass, Loading, Switch, type Tone } from './ui'

const selectClass = cn(
  inputClass,
  'h-10 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23888%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8 md:h-9',
)
const SHARE_TONE: Record<string, Tone> = { on: 'accent', off: 'neutral', warn: 'warn' }

/** A setting row inside the share dialog: title and description left, control right. */
function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line-subtle py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {desc && <div className="mt-0.5 text-[11.5px] text-ink-3">{desc}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

export interface ShareTarget {
  target_type: 'node' | 'repo'
  target_id: string
  title: string
  /** tables: the views a link may be restricted to */
  views?: { id: string; name: string }[]
}

type Preset = 'never' | '1' | '7' | '30' | 'custom' | ''

const DAY = 86_400_000

/** A random access password: 6 characters without look-alikes (0/O, 1/l/I). */
export function randomPassword(n = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Password input prefilled with a random password; it can be edited or re-rolled. */
function PasswordInput({ value, onChange, autoFocus, placeholder }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; placeholder?: string }) {
  return (
    <span className="flex min-w-0 flex-1 gap-2">
      <input
        className={cn(inputClass, 'h-10 min-w-0 flex-1 font-mono tracking-wider md:h-9')}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      <Button title="重新随机生成" onClick={() => onChange(randomPassword())}>
        随机生成
      </Button>
    </span>
  )
}

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

function ExpiryPicker({ value, custom, current, onChange }: { value: Preset; custom: string; current?: string; onChange: (p: Preset, custom: string) => void }) {
  const today = new Date()
  const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return (
    <div className="flex flex-wrap gap-2">
      <select className={cn(selectClass, 'w-auto min-w-36')} value={value} onChange={(e) => onChange(e.target.value as Preset, custom)}>
        {/* the link's current expiry date (choosing a preset replaces it) */}
        {current && <option value="">{current}</option>}
        <option value="never">永久有效</option>
        <option value="1">1 天</option>
        <option value="7">7 天</option>
        <option value="30">30 天</option>
        <option value="custom">自定义日期</option>
      </select>
      {value === 'custom' && <input className={cn(inputClass, 'h-10 w-auto md:h-9')} type="date" min={min} value={custom} onChange={(e) => onChange('custom', e.target.value)} />}
    </div>
  )
}

function ShareDialog({ target, onClose, onChanged }: { target: ShareTarget; onClose: () => void; onChanged?: () => void }) {
  const [share, setShare] = useState<Share | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // creation form / editing state
  const [password, setPassword] = useState(() => randomPassword())
  const [usePw, setUsePw] = useState(true)
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
      if (usePw && !password) throw new Error('请输入访问密码，或关闭密码保护')
      const sh = await api.createShare({
        target_type: target.target_type,
        target_id: target.target_id,
        password: (usePw && password) || undefined,
        expires_at: presetExpiry(preset, custom),
        view_id: viewId || null,
      })
      setLastPw(usePw ? password : '')
      setPassword('')
      return sh
    })

  const kind = target.target_type === 'repo' ? '知识库' : target.views ? '表格' : '文档'
  const viewPicker = (value: string, onChange: (v: string) => void) => (
    <select className={cn(selectClass, 'w-auto min-w-36')} value={value} onChange={(e) => onChange(e.target.value)}>
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
    body = <Loading className="py-12" />
  } else if (share === null) {
    body = (
      <>
        <ModalBody className="flex flex-col gap-4">
          <p className="m-0 rounded-md bg-inset px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            创建链接后，任何拿到链接的人都可以<strong className="font-semibold text-ink">只读</strong>访问这个{kind}
            {target.target_type === 'repo' ? '（含目录中的全部文档）' : ''}。
          </p>
          {target.views && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">可见范围</span>
              {viewPicker(viewId, setViewId)}
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-[12px] font-medium text-ink-2">
              访问密码
              <Switch label={usePw ? '关闭密码保护' : '开启密码保护'} checked={usePw} onChange={setUsePw} />
            </span>
            {usePw ? (
              <PasswordInput value={password} onChange={setPassword} placeholder="输入访问密码" />
            ) : (
              <span className="flex h-10 items-center rounded-md border border-dashed border-line px-3 text-[12.5px] text-ink-3 md:h-9">不设密码，拿到链接即可访问</span>
            )}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">有效期</span>
            <ExpiryPicker
              value={preset}
              custom={custom}
              onChange={(p, c) => {
                setPreset(p)
                setCustom(c)
              }}
            />
          </label>
        </ModalBody>
        <ModalActions>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={create}>
            创建分享链接
          </Button>
        </ModalActions>
      </>
    )
  } else {
    const url = shareURL(share.token)
    const st = shareState(share)
    body = (
      <>
        <ModalBody className="flex flex-col">
          <div className="flex gap-2">
            <input className={cn(inputClass, 'h-10 min-w-0 flex-1 bg-inset font-mono text-[12px] md:h-9')} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="primary" onClick={() => copyText(lastPw ? `${url}\n访问密码：${lastPw}` : url, lastPw ? '已复制链接和密码' : '链接已复制')}>
              {lastPw ? '复制链接和密码' : '复制链接'}
            </Button>
          </div>
          <div className="mt-2.5 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
            <Badge tone={SHARE_TONE[st.cls] ?? 'neutral'}>{st.text}</Badge>
            <span>{formatExpiry(share)}</span>
            <span className="tabular">访问 {share.view_count} 次</span>
            <a className="text-accent hover:underline" href={url} target="_blank" rel="noreferrer">
              打开
            </a>
          </div>

          <SettingRow title="允许访问" desc="关闭后链接立即失效，可随时重新开启">
            <Switch label="允许访问" checked={share.enabled} disabled={busy} onChange={(v) => run(() => api.updateShare(share.token, { enabled: v }))} />
          </SettingRow>

          {target.views && (
            <SettingRow title="可见范围" desc="访客可以切换的视图">
              {viewPicker(share.view_id ?? '', (v) => run(() => api.updateShare(share.token, { view_id: v || null })))}
            </SettingRow>
          )}

          <SettingRow title="访问密码" desc={share.has_password ? '已设置，访客需输入密码' : '未设置，拿到链接即可访问'}>
            {!editingPw && (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setPassword(randomPassword())
                    setEditingPw(true)
                  }}
                >
                  {share.has_password ? '修改' : '设置'}
                </Button>
                {share.has_password && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setLastPw('')
                        return api.updateShare(share.token, { password: '' })
                      })
                    }
                  >
                    移除
                  </Button>
                )}
              </>
            )}
          </SettingRow>
          {editingPw && (
            <form
              className="-mt-1 mb-3 flex flex-wrap gap-2"
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
              <PasswordInput autoFocus value={password} onChange={setPassword} placeholder="新密码" />
              <Button onClick={() => setEditingPw(false)}>取消</Button>
              <Button type="submit" variant="primary" disabled={!password || busy}>
                保存
              </Button>
            </form>
          )}

          <SettingRow title="有效期">
            <ExpiryPicker
              value={editPreset || (share.expires_at ? '' : 'never')}
              custom={custom}
              current={share.expires_at ? formatExpiry(share).replace('有效期至 ', '至 ') : undefined}
              onChange={(p, c) => {
                setCustom(c)
                // re-picking the current date changes nothing
                if (p === '') return setEditPreset('')
                if (p === 'custom' && !c) return setEditPreset('custom')
                setEditPreset('')
                if (p === 'never' && !share.expires_at) return
                run(() => api.updateShare(share.token, { expires_at: presetExpiry(p, c) }))
              }}
            />
          </SettingRow>
          <div className="border-t border-line-subtle pt-3 text-[11.5px] text-ink-4">创建于 {formatTime(share.created_at)}</div>
        </ModalBody>
        <ModalActions className="justify-between">
          <span className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (!(await confirmDialog('重新生成后，旧链接将立即失效。继续吗？', { okText: '重新生成' }))) return
                run(() => api.regenerateShare(share.token))
              }}
            >
              重新生成链接
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
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
            </Button>
          </span>
          <Button onClick={onClose}>完成</Button>
        </ModalActions>
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
