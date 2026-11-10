import { useCallback, useEffect, useState } from 'react'
import { api, formatSize, formatTime, getConfig, type BackupStatus, type ClientConfig, type StorageStats } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { IconArchive, IconCloud, IconDatabase, IconDisk, IconDoc, IconInfo, IconRefresh, IconSparkles, IconTrash } from '../components/icons'
import PageHeader from '../components/PageHeader'

export default function Settings() {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const loadStats = useCallback(() => api.storageStats().then(setStats).catch((e) => toast(e.message)), [])
  const loadBackup = useCallback(() => api.backupStatus().then(setBackup).catch((e) => toast(e.message)), [])

  useEffect(() => {
    loadStats()
    loadBackup()
    getConfig().then(setConfig).catch(() => {})
  }, [loadStats, loadBackup])

  // poll while a backup is running
  useEffect(() => {
    if (!backup?.running) return
    const t = window.setInterval(loadBackup, 2000)
    return () => clearInterval(t)
  }, [backup?.running, loadBackup])

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

  const runBackup = async () => {
    try {
      await api.runBackup()
      toast('备份已开始')
    } catch (e: any) {
      toast(e.message)
    }
    loadBackup()
  }

  const last = backup?.last
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

        <section className="settings-card">
          <h2>
            <span className="card-icon">
              <IconCloud width={16} height={16} />
            </span>
            自动备份
          </h2>
          {!backup ? (
            <div className="muted">加载中…</div>
          ) : !backup.enabled ? (
            <div className="settings-hint">
              <p>尚未配置备份目标。在环境变量中设置以下任意一项即可开启定时备份（数据库快照 + 附件增量）：</p>
              <ul>
                <li>
                  <code>QINGJIAN_BACKUP_DIR</code> — 本地目录（例如挂载的另一块硬盘）
                </li>
                <li>
                  <code>QINGJIAN_BACKUP_WEBDAV_URL</code> / <code>_USER</code> / <code>_PASSWORD</code> — WebDAV（坚果云、Nextcloud 等）
                </li>
                <li>
                  <code>QINGJIAN_BACKUP_S3_BUCKET</code> / <code>_ENDPOINT</code> / <code>_ACCESS_KEY</code> / <code>_SECRET_KEY</code> — S3 / MinIO / R2
                </li>
              </ul>
            </div>
          ) : (
            <>
              <div className="settings-kv">
                <span>备份目标</span>
                <span>
                  {backup.targets.map((t) => (
                    <div key={t}>{t}</div>
                  ))}
                </span>
                <span>频率</span>
                <span>
                  每 {backup.interval_hours} 小时，保留最近 {backup.keep} 份数据库快照
                </span>
                <span>上次备份</span>
                <span>
                  {backup.running ? (
                    '正在备份…'
                  ) : last ? (
                    <>
                      <span className={'share-badge ' + (last.ok ? 'on' : 'off')}>{last.ok ? '成功' : '失败'}</span> {formatTime(last.started_at)}，耗时{' '}
                      {Math.max(1, Math.round((last.finished_at - last.started_at) / 1000))} 秒
                    </>
                  ) : (
                    '尚未备份'
                  )}
                </span>
              </div>
              {last && !backup.running && (
                <div className="backup-results">
                  {last.results?.map((r) => (
                    <div key={r.target} className={r.ok ? '' : 'error'}>
                      {r.target}：{r.ok ? `完成，新增 ${r.files} 个附件` : r.error}
                    </div>
                  ))}
                  {!last.ok && !last.results?.length && <div className="error">{last.error}</div>}
                </div>
              )}
              <div className="settings-row end">
                <button className="btn primary" disabled={backup.running} onClick={runBackup}>
                  <IconRefresh width={15} height={15} className={backup.running ? 'spin' : ''} />
                  {backup.running ? '备份中…' : '立即备份'}
                </button>
              </div>
            </>
          )}
        </section>

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
