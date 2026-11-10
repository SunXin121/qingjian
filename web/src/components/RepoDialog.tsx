import { useId, useState } from 'react'
import type { Repo } from '../api'
import { Modal, mount } from './dialog'
import { RepoMark } from './icons'

const icons = ['📚', '📝', '📖', '💡', '🧠', '💻', '🎨', '🔬', '🌱', '🏠', '🗂️', '📌', '🎯', '🚀', '⭐', '❤️']
const graphemes = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

type RepoDetails = Pick<Repo, 'name' | 'description' | 'icon'>

function RepoForm({ repo, onDone }: { repo?: Repo; onDone: (value: RepoDetails | null) => void }) {
  const id = useId()
  const [name, setName] = useState(repo?.name ?? '')
  const [description, setDescription] = useState(repo?.description ?? '')
  const [icon, setIcon] = useState(repo?.icon ?? '')
  const glyph = icon.trim()
  const validIcon = Array.from(graphemes.segment(glyph)).length <= 1
  const valid = !!name.trim() && validIcon

  return (
    <Modal title={repo ? '编辑知识库' : '新建知识库'} onClose={() => onDone(null)}>
      <form onSubmit={(e) => {
        e.preventDefault()
        if (valid) onDone({ name: name.trim(), description, icon: glyph })
      }}>
        <div className="modal-body form">
          <label className="field">
            <span>名称</span>
            <input autoFocus required value={name} placeholder="例如：读书笔记" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="repo-icon-field">
            <label htmlFor={`${id}-icon`}>知识库图标</label>
            <div className="repo-icon-input">
              <RepoMark repo={{ id: repo?.id ?? '', name, icon: validIcon ? glyph : '' }} className="repo-icon-preview" />
              <input
                id={`${id}-icon`}
                value={icon}
                maxLength={32}
                placeholder="输入一个表情或文字"
                aria-describedby={`${id}-icon-hint`}
                aria-invalid={!validIcon}
                onChange={(e) => setIcon(e.target.value)}
              />
              <button type="button" className="btn sm" onClick={() => setIcon('')}>恢复默认</button>
            </div>
            <p id={`${id}-icon-hint`} className={'repo-icon-hint' + (validIcon ? '' : ' invalid')}>
              {validIcon ? '留空时使用知识库名称的首字。' : '请只输入一个表情或文字。'}
            </p>
            <div className="repo-icon-options" role="group" aria-label="常用图标">
              {icons.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={'repo-icon-option' + (glyph === value ? ' selected' : '')}
                  aria-label={`使用 ${value} 图标`}
                  aria-pressed={glyph === value}
                  onClick={() => setIcon(value)}
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
