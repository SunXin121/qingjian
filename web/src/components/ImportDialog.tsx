import { useEffect, useState } from 'react'
import { ApiError, formatSize, getConfig, type TreeNode } from '../api'
import { Modal, mount, toast } from './dialog'

// Importing markdown into a knowledge base: files, a folder or a zip (see import.go).

export interface ImportResult {
  docs: number
  groups: number
  attachments: number
  missing: string[]
  first: TreeNode | null
}

interface Entry {
  file: File
  /** relative path, including the chosen folder's name */
  path: string
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i
const hidden = (path: string) => path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX')

export const canPickFolder = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

/** Opens the file picker: markdown files (with their images) and zip archives, or a whole folder. */
export function pickImport(folder: boolean): Promise<{ entries: Entry[]; folder: boolean } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (folder) input.webkitdirectory = true
    else input.accept = '.md,.markdown,.mdown,.mkd,.zip,text/markdown,application/zip,image/*'
    input.onchange = () => {
      const files = [...(input.files ?? [])]
      resolve(files.length ? { entries: files.map((file) => ({ file, path: file.webkitRelativePath || file.name })), folder } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Files dropped from the desktop, walking into dropped folders. */
export async function droppedEntries(dt: DataTransfer): Promise<{ entries: Entry[]; folder: boolean }> {
  const items = [...dt.items].filter((i) => i.kind === 'file')
  const roots = items.map((i) => i.webkitGetAsEntry?.() ?? null)
  if (!roots.length || roots.some((r) => !r)) return { entries: [...dt.files].map((file) => ({ file, path: file.name })), folder: false }
  const out: Entry[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      out.push({ file, path: entry.fullPath.replace(/^\/+/, '') })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries returns the directory in chunks until an empty one
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) if (!e.name.startsWith('.')) await walk(e)
    }
  }
  for (const r of roots) await walk(r!)
  return { entries: out, folder: roots.some((r) => r!.isDirectory) }
}

export const isFileDrag = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files')

/**
 * Picks what to send: all markdown, and — from a folder, which may hold anything — only
 * the other files some document mentions by name.
 */
async function selectEntries(entries: Entry[], folder: boolean): Promise<Entry[]> {
  entries = entries.filter((e) => !hidden(e.path))
  if (!folder) return entries
  const md = entries.filter((e) => MD_EXT.test(e.path))
  const text = (await Promise.all(md.map((e) => e.file.text()))).join('\n')
  return entries.filter((e) => {
    if (MD_EXT.test(e.path)) return true
    const name = e.file.name
    return text.includes(name) || text.includes(encodeURIComponent(name)) || text.includes(name.replaceAll(' ', '%20'))
  })
}

function upload(repoId: string, parentId: string | null, entries: Entry[], onProgress: (ratio: number) => void): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    if (parentId) fd.append('parent_id', parentId)
    for (const e of entries) {
      fd.append('path', e.path)
      fd.append('file', e.file, e.file.name)
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/repos/${repoId}/import`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.upload.onload = () => onProgress(1)
    xhr.onload = () => {
      let data: any = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(xhr.status, data?.error || '导入失败', data))
    }
    xhr.onerror = () => reject(new ApiError(0, '网络错误，导入失败', null))
    xhr.send(fd)
  })
}

type Phase = { kind: 'upload'; ratio: number } | { kind: 'done'; result: ImportResult }

function ImportModal({ count, size, run, onClose }: { count: number; size: number; run: (set: (p: Phase) => void) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'upload', ratio: 0 })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(setPhase), [])
  const busy = phase.kind === 'upload'
  return (
    <Modal title={busy ? '正在导入' : '导入完成'} onClose={() => !busy && onClose()}>
      <div className="modal-body import-body">
        {phase.kind === 'upload' ? (
          <>
            <div className="import-meta">
              {count} 个文件 · {formatSize(size)}
            </div>
            <div className="import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(phase.ratio * 100)}>
              <div style={{ width: `${phase.ratio * 100}%` }} />
            </div>
            <div className="import-meta">{phase.ratio < 1 ? `上传中 ${Math.round(phase.ratio * 100)}%` : '正在解析文档…'}</div>
          </>
        ) : (
          <>
            <p>{summary(phase.result)}</p>
            <p className="import-warn">以下 {phase.result.missing.length} 处引用没有找到对应文件，已保持原样：</p>
            <ul className="import-missing">
              {phase.result.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      {!busy && (
        <div className="modal-actions">
          <button className="btn primary" autoFocus onClick={onClose}>
            确定
          </button>
        </div>
      )}
    </Modal>
  )
}

function summary(r: ImportResult) {
  const parts = [`已导入 ${r.docs} 篇文档`]
  if (r.groups) parts.push(`${r.groups} 个分组`)
  if (r.attachments) parts.push(`${r.attachments} 个附件`)
  return parts.join('，')
}

/** Uploads the entries, showing progress; resolves with the result (null when nothing was imported). */
export async function runImport(repoId: string, parentId: string | null, picked: { entries: Entry[]; folder: boolean }): Promise<ImportResult | null> {
  const entries = await selectEntries(picked.entries, picked.folder)
  if (!entries.some((e) => MD_EXT.test(e.path) || /\.zip$/i.test(e.path))) {
    toast('没有找到 Markdown 文件（.md / .markdown）')
    return null
  }
  const size = entries.reduce((n, e) => n + e.file.size, 0)
  const maxMB = await getConfig()
    .then((c) => c.max_upload_mb)
    .catch(() => 0)
  if (maxMB && size > maxMB * 1024 * 1024) {
    toast(`文件共 ${formatSize(size)}，超过 ${maxMB}MB 上传限制，请分批导入`, 4000)
    return null
  }
  return new Promise((resolve) => {
    mount((close) => (
      <ImportModal
        count={entries.length}
        size={size}
        onClose={close}
        run={(set) =>
          upload(repoId, parentId, entries, (ratio) => set({ kind: 'upload', ratio }))
            .then((result) => {
              resolve(result)
              if (result.missing.length) set({ kind: 'done', result })
              else {
                close()
                toast(summary(result))
              }
            })
            .catch((e) => {
              close()
              toast(e.message, 4000)
              resolve(null)
            })
        }
      />
    ))
  })
}
