import { useState } from 'react'
import { getConfig } from '../api'
import { Modal, mount, toast } from './dialog'

type Mode = 'zip' | 'imgbed'

function ExportChoice({ repo, onDone }: { repo: boolean; onDone: (m: Mode | null) => void }) {
  const [mode, setMode] = useState<Mode>('imgbed')
  const options: { mode: Mode; title: string; desc: string }[] = [
    {
      mode: 'imgbed',
      title: '上传图片到图床',
      desc: repo
        ? '图片和附件上传到图床，导出只含 Markdown 的压缩包，链接指向图床'
        : '图片和附件上传到图床，直接导出一个 .md 文件，链接指向图床',
    },
    { mode: 'zip', title: '打包附件', desc: '导出压缩包，图片和附件放在 assets/ 目录，使用相对链接' },
  ]
  return (
    <Modal title="导出 Markdown" onClose={() => onDone(null)}>
      <div className="modal-body">
        <div className="export-choice" role="radiogroup" aria-label="图片处理方式">
          {options.map((o) => (
            <label key={o.mode} className={mode === o.mode ? 'active' : ''}>
              <input type="radio" name="export-mode" checked={mode === o.mode} onChange={() => setMode(o.mode)} />
              <span>
                <strong>{o.title}</strong>
                <small>{o.desc}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => onDone(null)}>
          取消
        </button>
        <button className="btn primary" autoFocus onClick={() => onDone(mode)}>
          导出
        </button>
      </div>
    </Modal>
  )
}

function chooseMode(repo: boolean): Promise<Mode | null> {
  return new Promise((resolve) =>
    mount((close) => (
      <ExportChoice
        repo={repo}
        onDone={(m) => {
          close()
          resolve(m)
        }}
      />
    )),
  )
}

function filenameOf(disposition: string | null, fallback: string) {
  if (!disposition) return fallback
  const star = /filename\*=utf-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      /* fall through */
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallback
}

let busy = false

/**
 * Exports a document or knowledge base as markdown. When an image host is configured,
 * asks whether to upload the images there (no zip for a single document) or bundle them.
 */
export async function exportMarkdown(kind: 'doc' | 'repo', id: string) {
  const url = `/api/${kind}s/${id}/export`
  const cfg = await getConfig().catch(() => null)
  const mode = cfg?.imgbed ? await chooseMode(kind === 'repo') : 'zip'
  if (!mode) return
  if (mode === 'zip') {
    location.href = url
    return
  }
  if (busy) {
    toast('正在导出，请稍候')
    return
  }
  busy = true
  toast('正在上传图片到图床…')
  try {
    const res = await fetch(url + '?imgbed=1', { credentials: 'same-origin' })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      throw new Error(data?.error || res.statusText || '导出失败')
    }
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filenameOf(res.headers.get('Content-Disposition'), kind === 'doc' ? 'export.md' : 'export.zip')
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    toast('导出完成')
  } catch (e: any) {
    toast(e.message, 5000)
  } finally {
    busy = false
  }
}
