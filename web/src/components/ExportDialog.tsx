import { useState } from 'react'
import { getConfig } from '../api'
import { Modal, ModalActions, ModalBody, mount, toast } from './dialog'
import { Button, cn } from './ui'

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
      <ModalBody>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="图片处理方式">
          {options.map((o) => {
            const active = mode === o.mode
            return (
              <label
                key={o.mode}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors duration-(--dur-fast)',
                  active ? 'border-accent bg-accent-softer' : 'border-line hover:border-line-strong hover:bg-hover',
                )}
              >
                <input type="radio" name="export-mode" className="mt-1 accent-(--accent)" checked={active} onChange={() => setMode(o.mode)} />
                <span className="min-w-0 flex-1">
                  <strong className="block text-[13.5px] font-medium text-ink">{o.title}</strong>
                  <small className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">{o.desc}</small>
                </span>
              </label>
            )
          })}
        </div>
      </ModalBody>
      <ModalActions>
        <Button onClick={() => onDone(null)}>取消</Button>
        <Button variant="primary" autoFocus onClick={() => onDone(mode)}>
          导出
        </Button>
      </ModalActions>
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
