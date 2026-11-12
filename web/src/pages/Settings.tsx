import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { api, formatSize, getConfig, resetConfig, type ClientConfig, type ImgbedConfig, type StorageStats } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconArchive, IconCheck, IconCloud, IconDatabase, IconDisk, IconDoc, IconInfo, IconMonitor, IconMoon, IconPalette, IconSparkles, IconSun, IconTrash } from '../components/icons'
import { Crumb, PageBody } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Button, cn, Field, inputClass, Loading, Segmented } from '../components/ui'
import { ACCENTS, getAppearance, getThemeMode, PROSE_WIDTHS, setAppearance, setThemeMode, type Appearance, type ThemeMode } from '../theme'
import { DEFAULT_TYPOGRAPHY, EMPHASIS_STYLES, HEADING_STYLES, PROSE_FONTS, QUOTE_STYLES, TYPOGRAPHY_RANGES } from '../typography'

const SECTIONS = [
  { id: 'appearance', label: '外观', icon: <IconPalette /> },
  { id: 'storage', label: '存储空间', icon: <IconDisk /> },
  { id: 'imgbed', label: '图床', icon: <IconCloud /> },
  { id: 'about', label: '关于', icon: <IconInfo /> },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

/** One setting: label (and hint) on the left, its control on the right; stacks on phones. */
function Row({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 border-b border-line-subtle py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-6', className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {hint && <div className="mt-1 text-[12px] leading-relaxed text-ink-3">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

function Panel({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="animate-rise">
      <h2 className="m-0 text-[17px] font-semibold text-ink">{title}</h2>
      {desc && <p className="mt-1.5 mb-0 text-[12.5px] leading-relaxed text-ink-3">{desc}</p>}
      <div className="mt-4 rounded-lg border border-line-subtle bg-surface px-4 shadow-card md:px-5">{children}</div>
    </section>
  )
}

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const tab: SectionId = SECTIONS.some((x) => x.id === params.get('tab')) ? (params.get('tab') as SectionId) : 'appearance'
  const select = (id: SectionId) => setParams(id === 'appearance' ? {} : { tab: id }, { replace: true })

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb>设置</Crumb>
        </Crumbs>
      </PageHeader>
      <PageBody wide className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav className="no-scrollbar -mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 md:sticky md:top-[calc(var(--header-h)+40px)] md:mx-0 md:w-44 md:flex-col md:self-start md:overflow-visible md:px-0">
          <h1 className="m-0 mb-3 hidden px-2.5 text-[20px] font-semibold text-ink md:block">设置</h1>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              onClick={() => select(x.id)}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] whitespace-nowrap transition-colors duration-(--dur-fast) md:h-8 [&_svg]:size-4',
                tab === x.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink [&_svg]:text-ink-3',
              )}
            >
              {x.icon}
              {x.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {tab === 'appearance' && <AppearancePanel />}
          {tab === 'storage' && <StoragePanel />}
          {tab === 'imgbed' && <ImgbedCard />}
          {tab === 'about' && <AboutPanel />}
        </div>
      </PageBody>
    </div>
  )
}

const THEMES: { value: ThemeMode; title: string; icon: ReactNode }[] = [
  { value: 'light', title: '浅色', icon: <IconSun width={15} height={15} /> },
  { value: 'dark', title: '深色', icon: <IconMoon width={15} height={15} /> },
  { value: 'system', title: '跟随系统', icon: <IconMonitor width={15} height={15} /> },
]

function AppearancePanel() {
  const [theme, setTheme] = useState(getThemeMode)
  const [a, setA] = useState(getAppearance)
  const update = (patch: Partial<Appearance>) => {
    setAppearance(patch)
    setA(getAppearance())
  }
  return (
    <div className="flex flex-col gap-8">
      <Panel title="外观" desc="保存在当前浏览器中，不同设备可以分别设置。">
        <Row label="主题" hint="深色模式会在夜间减少刺眼的亮光。">
          <Segmented
            label="主题"
            value={theme}
            options={THEMES.map((t) => ({ ...t, label: t.title }))}
            onChange={(m) => {
              setThemeMode(m)
              setTheme(m)
            }}
          />
        </Row>
        <Row label="强调色" hint="按钮、选中项和链接使用的颜色。最后一个可以自定义。">
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="强调色">
            {ACCENTS.map((x) => (
              <button
                key={x.id}
                role="radio"
                aria-checked={a.accent === x.id}
                title={x.name}
                aria-label={x.name}
                onClick={() => update({ accent: x.id })}
                className={cn(
                  'grid size-7 place-items-center rounded-full text-white transition-[box-shadow,transform] duration-(--dur-fast) ease-spring hover:scale-110 md:size-6',
                  a.accent === x.id && 'shadow-[0_0_0_2px_var(--bg-surface),0_0_0_4px_var(--accent)]',
                )}
                style={{ background: x.swatch }}
              >
                {a.accent === x.id && <IconCheck width={13} height={13} strokeWidth={2.5} />}
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            {/* the label opens the native colour picker; picking a colour also selects it */}
            <label
              role="radio"
              aria-checked={a.accent === 'custom'}
              title="自定义颜色"
              className={cn(
                'relative grid size-7 cursor-pointer place-items-center rounded-full transition-[box-shadow,transform] duration-(--dur-fast) ease-spring hover:scale-110 md:size-6',
                a.accent === 'custom' && 'shadow-[0_0_0_2px_var(--bg-surface),0_0_0_4px_var(--accent)]',
              )}
              style={{
                background:
                  a.accent === 'custom' ? a.customAccent : 'conic-gradient(from 90deg, #e5484d, #f5a524, #46a758, #0d9488, #3e63dd, #8e4ec6, #e5484d)',
                color: 'var(--accent-contrast)',
              }}
              onClick={() => a.accent !== 'custom' && update({ accent: 'custom' })}
            >
              {a.accent === 'custom' && <IconCheck width={13} height={13} strokeWidth={2.5} />}
              <input
                type="color"
                aria-label="自定义强调色"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                value={a.customAccent}
                onChange={(e) => update({ accent: 'custom', customAccent: e.target.value })}
              />
            </label>
            {a.accent === 'custom' && <span className="font-mono text-[11.5px] text-ink-3 uppercase">{a.customAccent}</span>}
          </div>
        </Row>
        <Row label="背景" hint="暖纸色更柔和，纯白更干净。">
          {(['paper', 'white'] as const).map((bg) => (
            <button
              key={bg}
              onClick={() => update({ background: bg })}
              aria-pressed={a.background === bg}
              className={cn(
                'flex h-9 items-center gap-2 rounded-md border px-3 text-[12.5px] transition-[border-color,box-shadow] duration-(--dur-fast) md:h-8',
                a.background === bg ? 'border-accent text-ink shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-line text-ink-2 hover:border-line-strong',
              )}
            >
              <span className={cn('size-4 rounded-full border border-line-strong', bg === 'paper' ? 'bg-[#f6f2ea]' : 'bg-white')} />
              {bg === 'paper' ? '暖纸' : '纯白'}
              {a.background === bg && <IconCheck width={13} height={13} className="text-accent" />}
            </button>
          ))}
        </Row>
      </Panel>

      <Panel title="阅读与写作" desc="即时生效于文档正文和分享页；字体使用当前设备已安装的字体，缺失时自动回退。">
        <Row label="正文字体">
          <select aria-label="正文字体" className={cn(inputClass, 'h-9 w-44')} value={a.proseFont} onChange={(e) => update({ proseFont: e.target.value as Appearance['proseFont'] })}>
            {Object.entries(PROSE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
          </select>
        </Row>
        {a.proseFont === 'custom' && (
          <Row label="本机字体名称" hint="输入一个已安装的字体名称，例如 LXGW WenKai、思源黑体或 Microsoft YaHei。">
            <input aria-label="本机字体名称" className={cn(inputClass, 'h-9 w-52')} maxLength={100} value={a.customFont} placeholder="例如 LXGW WenKai" onChange={(e) => update({ customFont: e.target.value })} />
          </Row>
        )}
        {([
          ['proseSize', '正文字号', 'px'],
          ['proseLine', '行高', '倍'],
          ['proseTracking', '字间距', 'em'],
          ['paragraphSpace', '额外段间距', 'px'],
        ] as const).map(([key, label, unit]) => (
          <Row key={key} label={label} hint={key === 'paragraphSpace' ? '在原有段落留白基础上增加距离。' : undefined}>
            <input type="range" {...TYPOGRAPHY_RANGES[key]} value={a[key]} aria-label={label} onChange={(e) => update({ [key]: e.target.valueAsNumber })} className="w-28 accent-(--accent) sm:w-36" />
            <input key={a[key]} type="number" {...TYPOGRAPHY_RANGES[key]} defaultValue={a[key]} aria-label={`${label}数值`} onBlur={(e) => { if (Number.isFinite(e.target.valueAsNumber)) update({ [key]: e.target.valueAsNumber }); e.target.value = String(getAppearance()[key]) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={cn(inputClass, 'tabular h-9 w-20 text-right')} />
            <span className="w-5 text-[12px] text-ink-3">{unit}</span>
          </Row>
        ))}
        <Row label="内容宽度">
          <Segmented label="内容宽度" value={a.proseWidth} options={(Object.keys(PROSE_WIDTHS) as (keyof typeof PROSE_WIDTHS)[]).map((k) => ({ value: k, label: PROSE_WIDTHS[k].label }))} onChange={(v) => update({ proseWidth: v })} />
        </Row>
        <Row label="正文对齐">
          <Segmented label="正文对齐" value={a.textAlign} options={[{ value: 'left', label: '左对齐' }, { value: 'justify', label: '两端对齐' }]} onChange={(v) => update({ textAlign: v })} />
        </Row>
        <Row label="标题样式">
          <Segmented label="标题样式" value={a.headingStyle} options={(Object.keys(HEADING_STYLES) as (keyof typeof HEADING_STYLES)[]).map((value) => ({ value, label: HEADING_STYLES[value] }))} onChange={(headingStyle) => update({ headingStyle })} />
        </Row>
        <Row label="引用样式">
          <select aria-label="引用样式" className={cn(inputClass, 'h-9 w-44')} value={a.quoteStyle} onChange={(e) => update({ quoteStyle: e.target.value as Appearance['quoteStyle'] })}>
            {Object.entries(QUOTE_STYLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Row>
        <Row label="强调样式">
          <Segmented label="强调样式" value={a.emphasisStyle} options={(Object.keys(EMPHASIS_STYLES) as (keyof typeof EMPHASIS_STYLES)[]).map((value) => ({ value, label: EMPHASIS_STYLES[value] }))} onChange={(emphasisStyle) => update({ emphasisStyle })} />
        </Row>
        <Row label="恢复默认排版" hint="重置字体和排版设置。">
          <Button onClick={() => update(DEFAULT_TYPOGRAPHY)}>恢复默认</Button>
        </Row>
        <div className="border-t border-line-subtle py-4">
          <div className="mb-2 text-[11.5px] font-medium text-ink-4">效果预览</div>
          <div className="overflow-hidden rounded-lg border border-line-subtle bg-editor px-5 py-4">
            <div className="ink-editor typography-preview mx-auto" style={{ maxWidth: 'var(--prose-width)' }}>
              <div className="milkdown"><div className="ProseMirror">
                <h2>山中问答</h2>
                <p>问余何意栖碧山，笑而不答心自闲。桃花流水窅然去，别有天地非人间。</p>
                <p>写下此刻的想法，让<strong>重要的文字</strong>清晰可见。Typography brings rhythm to reading，中英文与 <code>inline code</code> 会像这样排在一起。</p>
                <h3>留一点空白</h3>
                <blockquote><p>在文字之间，找到适合自己的阅读节奏。</p></blockquote>
              </div></div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

function StoragePanel() {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const loadStats = useCallback(() => api.storageStats().then(setStats).catch((e) => toast(e.message)), [])
  useEffect(() => {
    loadStats()
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
    <Panel title="存储空间" desc="全部数据都在服务器的 data 目录：数据库和按内容去重的附件。">
      {stats ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 py-4 lg:grid-cols-4">
            <Stat icon={<IconDoc width={14} height={14} />} label="文档" value={String(stats.docs)} sub={`${stats.versions} 个历史版本`} />
            <Stat icon={<IconDatabase width={14} height={14} />} label="数据库" value={formatSize(stats.db_bytes)} />
            <Stat icon={<IconArchive width={14} height={14} />} label="附件" value={formatSize(stats.stored_bytes)} sub={`${stats.attachments} 个，去重后 ${stats.blobs} 份`} />
            <Stat icon={<IconTrash width={14} height={14} />} label="未引用附件" value={formatSize(stats.unreferenced_bytes)} sub={`${stats.unreferenced} 个`} />
          </div>
          <Row
            label="清理未引用附件"
            hint={`未引用附件指已不在任何文档（含回收站）和历史版本中出现的文件。最近 ${stats.grace_hours} 小时内上传的文件不会被清理。`}
          >
            <Button icon={<IconSparkles width={14} height={14} />} loading={cleaning} disabled={stats.unreferenced === 0} onClick={cleanup}>
              {cleaning ? '清理中…' : '清理'}
            </Button>
          </Row>
        </>
      ) : (
        <Loading className="py-10" />
      )}
    </Panel>
  )
}

function AboutPanel() {
  const [config, setConfig] = useState<ClientConfig | null>(null)
  useEffect(() => {
    getConfig().then(setConfig).catch(() => {})
  }, [])
  const rows: [string, string][] = [
    ['版本', config?.version ?? '—'],
    ['附件上限', config ? `${config.max_upload_mb} MB` : '—'],
    ['回收站保留', config ? `${config.trash_days} 天` : '—'],
    ['draw.io', config?.drawio_url ?? '—'],
  ]
  return (
    <Panel title="关于" desc="青简 Qingjian · 个人自托管的在线知识库。">
      {rows.map(([k, v]) => (
        <Row key={k} label={k}>
          <span className="max-w-72 truncate font-mono text-[12px] text-ink-2">{v}</span>
        </Row>
      ))}
    </Panel>
  )
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line-subtle bg-editor p-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        {icon}
        {label}
      </div>
      <div className="tabular mt-2 text-[18px] leading-none font-semibold text-ink">{value}</div>
      {sub && <div className="mt-1.5 text-[11px] text-ink-4">{sub}</div>}
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

  const selectClass = cn(inputClass, 'h-10 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23888%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8 md:h-9')
  const text = cn(inputClass, 'h-10 md:h-9')
  return (
    <Panel
      title="图床"
      desc={
        <>
          配置{' '}
          <a className="text-accent hover:underline" href="https://cfbed.sanyue.de/" target="_blank" rel="noreferrer">
            CloudFlare ImgBed
          </a>{' '}
          后，导出 Markdown 时可以选择把图片和附件上传到图床，导出的文档直接引用图床链接，无需再打包压缩包。
        </>
      }
    >
      {!saved ? (
        <Loading className="py-10" />
      ) : (
        <form onSubmit={save}>
          <div className="grid gap-x-4 gap-y-3.5 py-4 sm:grid-cols-2">
            <Field label="图床地址" className="sm:col-span-2">
              <input className={text} value={form.url} placeholder="https://img.example.com（留空则关闭）" onChange={(e) => set('url', e.target.value)} />
            </Field>
            <Field label="上传认证码">
              <input className={text} type="password" autoComplete="off" value={form.auth_code} placeholder="未设置可留空" onChange={(e) => set('auth_code', e.target.value)} />
            </Field>
            <Field label="API Token">
              <input className={text} type="password" autoComplete="off" value={form.token} placeholder="需要 upload 权限，可留空" onChange={(e) => set('token', e.target.value)} />
            </Field>
            <Field label="上传渠道">
              <select className={selectClass} value={form.channel} onChange={(e) => set('channel', e.target.value as ImgbedConfig['channel'])}>
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="渠道名称">
              <input className={text} value={form.channel_name} placeholder="同类渠道有多个时填写" onChange={(e) => set('channel_name', e.target.value)} />
            </Field>
            <Field label="上传目录">
              <input className={text} value={form.folder} placeholder="如 qingjian/img" onChange={(e) => set('folder', e.target.value)} />
            </Field>
            <Field label="文件命名">
              <select className={selectClass} value={form.name_type} onChange={(e) => set('name_type', e.target.value as ImgbedConfig['name_type'])}>
                {NAME_TYPES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Row label="上传记录" hint={`已上传过的文件会被记住，重复导出不会重复上传（已记录 ${uploaded} 个）。`} className="border-t">
            <Button disabled={uploaded === 0} onClick={forget}>
              清除上传记录
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </Row>
        </form>
      )}
    </Panel>
  )
}
