import { useCallback, useEffect, useState } from 'react'
import { api, formatSize, getConfig, resetConfig, type ClientConfig, type ImgbedConfig, type StorageStats } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconArchive, IconCloud, IconDatabase, IconDisk, IconDoc, IconInfo, IconSparkles, IconTrash } from '../components/icons'
import PageHeader from '../components/PageHeader'
import { getThemeMode, setThemeMode, type ThemeMode } from '../theme'

const THEMES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
]

export default function Settings() {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [theme, setTheme] = useState(getThemeMode)

  const loadStats = useCallback(() => api.storageStats().then(setStats).catch((e) => toast(e.message)), [])

  useEffect(() => {
    loadStats()
    getConfig().then(setConfig).catch(() => {})
  }, [loadStats])

  const cleanup = async () => {
    if (!stats) return
    const ok = await confirmDialog(
      `将删除 ${stats.unreferenced} 个未被任何文档或历史版本引用的附件，释放约 ${formatSize(stats.unreferenced_bytes)}。此操作不可撤销。`,
      { danger: true, okText: '清理' },
    )
    if (!ok) return
    setCleaning(true)
    try {
      const r = await api.cleanupFiles()
      toast(`已清理 ${r.removed} 个附件，释放 ${formatSize(r.freed_bytes)}`)
      loadStats()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="page">
      <PageHeader>
        <span className="crumb">设置</span>
      </PageHeader>
      <div className="page-body settings">
        <h1 className="page-title">设置</h1>

        <section className="settings-card">
          <h2>
            <span className="card-icon">
              <IconSparkles width={16} height={16} />
            </span>
            外观
          </h2>
          <div className="settings-row">
            <p className="muted">界面主题。保存在当前浏览器中，不同设备可以分别设置。</p>
            <div className="seg" role="radiogroup" aria-label="界面主题">
              {THEMES.map((t) => (
                <button
                  key={t.mode}
                  role="radio"
                  aria-checked={theme === t.mode}
                  className={theme === t.mode ? 'active' : ''}
                  onClick={() => {
                    setThemeMode(t.mode)
                    setTheme(t.mode)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-card">
          <h2>
            <span className="card-icon">
              <IconDisk width={16} height={16} />
            </span>
            存储空间
          </h2>
          {stats ? (
            <>
              <div className="stat-grid">
                <Stat icon={<IconDoc width={15} height={15} />} label="文档" value={String(stats.docs)} sub={`${stats.versions} 个历史版本`} />
                <Stat icon={<IconDatabase width={15} height={15} />} label="数据库" value={formatSize(stats.db_bytes)} />
                <Stat icon={<IconArchive width={15} height={15} />} label="附件" value={formatSize(stats.stored_bytes)} sub={`${stats.attachments} 个，去重后 ${stats.blobs} 份`} />
                <Stat icon={<IconTrash width={15} height={15} />} label="未引用附件" value={formatSize(stats.unreferenced_bytes)} sub={`${stats.unreferenced} 个`} />
              </div>
              <div className="settings-row">
                <p className="muted">
                  未引用附件指已不在任何文档（含回收站）和历史版本中出现的文件。最近 {stats.grace_hours} 小时内上传的文件不会被清理。
                </p>
                <button className="btn" disabled={cleaning || stats.unreferenced === 0} onClick={cleanup}>
                  <IconSparkles width={15} height={15} />
                  {cleaning ? '清理中…' : '清理未引用附件'}
                </button>
              </div>
            </>
          ) : (
            <div className="muted">加载中…</div>
          )}
        </section>

        <ImgbedCard />

        <section className="settings-card">
          <h2>
            <span className="card-icon">
              <IconInfo width={16} height={16} />
            </span>
            关于
          </h2>
          <div className="settings-kv">
            <span>版本</span>
            <span>{config?.version ?? '—'}</span>
            <span>附件上限</span>
            <span>{config ? `${config.max_upload_mb} MB` : '—'}</span>
            <span>回收站保留</span>
            <span>{config ? `${config.trash_days} 天` : '—'}</span>
            <span>draw.io</span>
            <span className="ellipsis">{config?.drawio_url ?? '—'}</span>
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

const CHANNELS: { value: ImgbedConfig['channel']; label: string }[] = [
  { value: '', label: '图床默认' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'cfr2', label: 'Cloudflare R2' },
  { value: 's3', label: 'S3' },
  { value: 'discord', label: 'Discord' },
  { value: 'huggingface', label: 'Hugging Face' },
  { value: 'webdav', label: 'WebDAV' },
]

const NAME_TYPES: { value: ImgbedConfig['name_type']; label: string }[] = [
  { value: '', label: '图床默认' },
  { value: 'default', label: '前缀_原文件名' },
  { value: 'index', label: '仅前缀' },
  { value: 'origin', label: '仅原文件名' },
  { value: 'short', label: '短链接' },
]

const EMPTY_IMGBED: ImgbedConfig = { url: '', auth_code: '', token: '', channel: '', channel_name: '', folder: '', name_type: '' }

/** CloudFlare ImgBed settings: where exports upload their images. */
function ImgbedCard() {
  const [saved, setSaved] = useState<ImgbedConfig | null>(null)
  const [form, setForm] = useState<ImgbedConfig>(EMPTY_IMGBED)
  const [uploaded, setUploaded] = useState(0)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    () =>
      api
        .imgbed()
        .then((r) => {
          setSaved(r.config)
          setForm(r.config)
          setUploaded(r.uploaded)
        })
        .catch((e) => toast(e.message)),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const set = <K extends keyof ImgbedConfig>(k: K, v: ImgbedConfig[K]) => setForm((f) => ({ ...f, [k]: v }))
  const dirty = !!saved && (Object.keys(form) as (keyof ImgbedConfig)[]).some((k) => form[k] !== saved[k])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const c = await api.saveImgbed(form)
      setSaved(c)
      setForm(c)
      resetConfig()
      toast(c.url ? '图床设置已保存' : '已关闭图床')
    } catch (err: any) {
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    const ok = await confirmDialog(`将清除 ${uploaded} 条上传记录，下次导出时会重新上传所有图片。适用于图床上的文件已被删除的情况。`, { okText: '清除' })
    if (!ok) return
    try {
      await api.forgetImgbed()
      toast('已清除上传记录')
      load()
    } catch (err: any) {
      toast(err.message)
    }
  }

  return (
    <section className="settings-card">
      <h2>
        <span className="card-icon">
          <IconCloud width={16} height={16} />
        </span>
        图床
      </h2>
      {!saved ? (
        <div className="muted">加载中…</div>
      ) : (
        <form onSubmit={save}>
          <p className="muted settings-desc">
            配置{' '}
            <a href="https://cfbed.sanyue.de/" target="_blank" rel="noreferrer">
              CloudFlare ImgBed
            </a>{' '}
            后，导出 Markdown 时可以选择把图片和附件上传到图床，导出的文档直接引用图床链接，无需再打包压缩包。
          </p>
          <div className="imgbed-form">
            <label className="field wide">
              <span>图床地址</span>
              <input value={form.url} placeholder="https://img.example.com（留空则关闭）" onChange={(e) => set('url', e.target.value)} />
            </label>
            <label className="field">
              <span>上传认证码</span>
              <input type="password" autoComplete="off" value={form.auth_code} placeholder="未设置可留空" onChange={(e) => set('auth_code', e.target.value)} />
            </label>
            <label className="field">
              <span>API Token</span>
              <input type="password" autoComplete="off" value={form.token} placeholder="需要 upload 权限，可留空" onChange={(e) => set('token', e.target.value)} />
            </label>
            <label className="field">
              <span>上传渠道</span>
              <select value={form.channel} onChange={(e) => set('channel', e.target.value as ImgbedConfig['channel'])}>
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>渠道名称</span>
              <input value={form.channel_name} placeholder="同类渠道有多个时填写" onChange={(e) => set('channel_name', e.target.value)} />
            </label>
            <label className="field">
              <span>上传目录</span>
              <input value={form.folder} placeholder="如 qingjian/img" onChange={(e) => set('folder', e.target.value)} />
            </label>
            <label className="field">
              <span>文件命名</span>
              <select value={form.name_type} onChange={(e) => set('name_type', e.target.value as ImgbedConfig['name_type'])}>
                {NAME_TYPES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="settings-row">
            <p className="muted">已上传过的文件会被记住，重复导出不会重复上传（已记录 {uploaded} 个）。</p>
            <div className="settings-actions">
              <button type="button" className="btn" disabled={uploaded === 0} onClick={forget}>
                清除上传记录
              </button>
              <button type="submit" className="btn primary" disabled={busy || !dirty}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  )
}
