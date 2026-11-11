import { useId, useRef, useState } from 'react'
import { api, uploadFile, type Repo } from '../api'
import { confirmDialog, Modal, mount, openMenu, toast } from './dialog'
import { IconDownload, IconEdit, IconFolder, IconShare, IconTrash, IconUpload, RepoMark } from './icons'
import { canPickFolder } from './ImportDialog'
import { openShareDialog } from './ShareDialog'
import { exportMarkdown } from './ExportDialog'

const icons = ['📚', '📝', '📖', '💡', '🧠', '💻', '🎨', '🔬', '🌱', '🏠', '🗂️', '📌', '🎯', '🚀', '⭐', '❤️']
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
type RepoDetails = Pick<Repo, 'name' | 'description' | 'icon'>

async function prepareIcon(file: File): Promise<Blob> {
  if (!imageTypes.includes(file.type)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片。')
  if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5MB。')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('无法读取这张图片，请换一张图片。')
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法处理图片，请重试。')
    const side = Math.min(bitmap.width, bitmap.height)
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法处理图片，请重试。')), 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

function RepoForm({ repo, onDone }: { repo?: Repo; onDone: (value: RepoDetails | null) => void }) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(repo?.name ?? '')
  const [description, setDescription] = useState(repo?.description ?? '')
  const [icon, setIcon] = useState(repo?.icon ?? '')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const valid = !!name.trim() && !uploading

  const selectIcon = (value: string) => {
    setIcon(value)
    setError('')
  }
  const uploadIcon = async (file: File) => {
    setUploading(true)
    setError('')
    try {
      const image = await prepareIcon(file)
      const attachment = await uploadFile(image, 'knowledge-base-icon.png')
      setIcon(attachment.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重试。')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal title={repo ? '编辑知识库' : '新建知识库'} onClose={() => onDone(null)}>
      <form onSubmit={(e) => {
        e.preventDefault()
        if (valid) onDone({ name: name.trim(), description, icon })
      }}>
        <div className="modal-body form">
          <label className="field">
            <span>名称</span>
            <input autoFocus required value={name} placeholder="例如：读书笔记" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="repo-icon-field" role="group" aria-labelledby={`${id}-icon-label`} aria-busy={uploading}>
            <div id={`${id}-icon-label`} className="repo-icon-label">知识库图标</div>
            <div className="repo-icon-upload">
              <RepoMark repo={{ id: repo?.id ?? '', name, icon }} className="repo-icon-preview" />
              <div className="repo-icon-upload-main">
                <div className="repo-icon-upload-actions">
                  <button type="button" className="btn sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
                    <IconUpload width={14} height={14} /> {uploading ? '上传中…' : '上传图片'}
                  </button>
                  <button type="button" className="btn sm ghost" disabled={uploading || !icon} onClick={() => selectIcon('')}>恢复默认</button>
                </div>
                <p className="repo-icon-hint">PNG、JPG、WebP、GIF，最大 5MB；居中裁切，动图使用首帧。</p>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept={imageTypes.join(',')}
                aria-label="上传知识库图标"
                hidden
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void uploadIcon(file)
                }}
              />
            </div>
            {error && <p className="repo-icon-error" role="alert">{error}</p>}
            <div className="repo-icon-options" role="group" aria-label="常用图标">
              {icons.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={'repo-icon-option' + (icon === value ? ' selected' : '')}
                  aria-label={`使用 ${value} 图标`}
                  aria-pressed={icon === value}
                  disabled={uploading}
                  onClick={() => selectIcon(value)}
                >{value}</button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>简介</span>
            <textarea rows={3} value={description} placeholder="可选" onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>取消</button>
          <button type="submit" className="btn primary" disabled={!valid}>{repo ? '保存' : '创建'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function editRepoDialog(repo?: Repo): Promise<RepoDetails | null> {
  return new Promise((resolve) => {
    mount((close) => <RepoForm repo={repo} onDone={(value) => {
      close()
      resolve(value)
    }} />)
  })
}

/**
 * Edit / share / import / export / delete menu for a knowledge base. The import entries
 * show when `onImport` is given; it must open the file picker right away (user gesture).
 */
export function repoMenu(el: HTMLElement, r: Repo, after: () => void, onDeleted?: () => void, onImport?: (folder: boolean) => void) {
  openMenu(el, [
    {
      label: '编辑信息',
      icon: <IconEdit />,
      onClick: async () => {
        const v = await editRepoDialog(r)
        if (!v) return
        await api.updateRepo(r.id, v)
        after()
      },
    },
    { label: '分享知识库', icon: <IconShare />, onClick: () => openShareDialog({ target_type: 'repo', target_id: r.id, title: r.name }) },
    { label: '导入 Markdown / zip', icon: <IconUpload />, divider: true, hidden: !onImport, onClick: () => onImport?.(false) },
    { label: '导入文件夹', icon: <IconFolder />, hidden: !onImport || !canPickFolder, onClick: () => onImport?.(true) },
    { label: '导出为 Markdown', icon: <IconDownload />, onClick: () => exportMarkdown('repo', r.id) },
    {
      label: '删除知识库',
      icon: <IconTrash />,
      danger: true,
      divider: true,
      onClick: async () => {
        if (!(await confirmDialog(`确定删除知识库「${r.name}」吗？可在回收站中恢复。`, { danger: true, okText: '删除' }))) return
        await api.deleteRepo(r.id)
        toast('已移入回收站')
        after()
        onDeleted?.()
      },
    },
  ])
}
