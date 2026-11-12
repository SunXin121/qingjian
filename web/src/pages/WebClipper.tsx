import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { Scissors } from 'lucide-react'
import { api, type TreeNode } from '../api'
import { CLIP_DRAFT_KEY, CLIP_EVENT, clipMarkdown, parseClipDraft, type ClipDraft } from '../clipper'
import PageHeader from '../components/PageHeader'
import ClipperSetup from '../components/ClipperSetup'
import { PageBody, PageTitle } from '../components/page'
import { Button, EmptyState, Field, Input, Segmented, Textarea, inputClass } from '../components/ui'
import { childrenMap, nodeTitle, useStore } from '../store'

const MODE_NAMES = { article: '正文', selection: '选中内容', page: '整页', link: '仅链接' }

export default function WebClipper() {
  const { repos, loadRepos } = useStore()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<ClipDraft | null>(null)
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [repoId, setRepoId] = useState('')
  const [parentId, setParentId] = useState('')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeReady, setTreeReady] = useState(false)
  const [view, setView] = useState<'preview' | 'markdown'>('preview')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    const receive = () => {
      try {
        const raw = sessionStorage.getItem(CLIP_DRAFT_KEY)
        if (!raw || raw === loaded.current) return
        const clip = parseClipDraft(JSON.parse(raw), true)
        loaded.current = raw
        setDraft(clip)
        setTitle(clip.title)
        setMarkdown(clip.markdown)
        setError('')
      } catch (e) { setError((e as Error).message || '无法读取剪藏草稿') }
    }
    window.addEventListener(CLIP_EVENT, receive)
    receive()
    return () => window.removeEventListener(CLIP_EVENT, receive)
  }, [])

  // Preserve edits through refreshes and login expiry in this same tab.
  useEffect(() => {
    if (!draft || saving.current) return
    try {
      const raw = JSON.stringify({ ...draft, title, markdown })
      sessionStorage.setItem(CLIP_DRAFT_KEY, raw)
      loaded.current = raw
    } catch { setError('无法暂存草稿，请检查浏览器存储空间') }
  }, [draft, title, markdown])

  useEffect(() => {
    if (!repoId && repos.length) setRepoId(repos[0].id)
  }, [repoId, repos])

  useEffect(() => {
    let active = true
    setTreeReady(false)
    setTree([])
    if (repoId) api.tree(repoId).then((nodes) => {
      if (active) { setTree(nodes); setTreeReady(true) }
    }).catch((e) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [repoId])

  const destinations = useMemo(() => {
    const children = childrenMap(tree)
    const out: { id: string; label: string }[] = []
    const walk = (parent: string | null, path: string) => {
      for (const node of children.get(parent) || []) {
        const label = path ? `${path} / ${nodeTitle(node)}` : nodeTitle(node)
        out.push({ id: node.id, label })
        walk(node.id, label)
      }
    }
    walk(null, '')
    return out
  }, [tree])

  const html = useMemo(() => DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    // Preview external images only when the user opens the saved document.
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'form', 'input'],
    FORBID_ATTR: ['style'],
  }), [markdown])

  const save = async () => {
    if (!draft || saving.current || !repoId || !treeReady) return
    saving.current = true
    setBusy(true)
    setError('')
    try {
      const clip = parseClipDraft({ ...draft, title, markdown })
      const node = await api.createNode(repoId, parentId || null, 'doc', clip.title, clipMarkdown(clip))
      sessionStorage.removeItem(CLIP_DRAFT_KEY)
      loadRepos().catch(() => {})
      navigate(`/r/${repoId}/d/${node.id}`, { replace: true })
    } catch (e) {
      setError((e as Error).message || '保存失败，请重试')
      saving.current = false
      setBusy(false)
    }
  }

  const discard = () => {
    sessionStorage.removeItem(CLIP_DRAFT_KEY)
    loaded.current = null
    setDraft(null)
    setTitle('')
    setMarkdown('')
    setError('')
  }

  return (
    <div>
      <PageHeader />
      <PageBody>
        <PageTitle sub="剪藏正文、页面区域、图片和平台内容，保存到自己的知识库。">网页剪藏</PageTitle>
        {error && <p role="alert" className="mb-4 rounded-md border border-line bg-surface p-3 text-[13px] text-danger">{error}</p>}
        {!draft ? (
          <>
          <ClipperSetup />
          <div className="rounded-lg border border-line-subtle bg-surface p-6">
            <EmptyState icon={<Scissors />} title="预览后保存">
              在扩展中选择「预览 / 整页 / 仅链接」，可以在这里编辑草稿并选择目录；扩展的「剪藏当前页面」和右键菜单会直接保存。
            </EmptyState>
            <Field label="本站地址"><Input readOnly value={window.location.origin} onFocus={(e) => e.currentTarget.select()} /></Field>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-3">没有安装扩展时，请先按照项目 extension/README.md 构建并加载。Chrome / Edge 使用 extension/dist，Firefox 使用 extension/dist-firefox。</p>
          </div>
          </>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
              <span className="rounded bg-active px-2 py-1">{MODE_NAMES[draft.mode]}</span>
              <a href={draft.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-accent">{draft.url}</a>
              <span>{new Date(draft.capturedAt).toLocaleString()}</span>
            </div>
            <Field label="标题"><Input value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} disabled={busy} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="知识库">
                <select className={`${inputClass} h-10`} value={repoId} disabled={busy} onChange={(e) => { setRepoId(e.target.value); setParentId(''); setError('') }}>
                  {!repos.length && <option value="">暂无知识库</option>}
                  {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
                </select>
              </Field>
              <Field label="保存位置">
                <select className={`${inputClass} h-10`} value={parentId} disabled={busy || !treeReady} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">知识库根目录</option>
                  {destinations.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
                </select>
              </Field>
            </div>
            {!repos.length && <p className="text-[13px] text-ink-3">请先到<Link to="/" className="text-accent">首页创建知识库</Link>，草稿会保留在当前标签页。</p>}
            <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface">
              <div className="flex items-center justify-between gap-3 border-b border-line-subtle p-3">
                <Segmented value={view} onChange={setView} options={[{ value: 'preview', label: '预览' }, { value: 'markdown', label: 'Markdown' }]} label="内容显示方式" />
                <span className="text-[11px] text-ink-4">{markdown.length.toLocaleString()} 字符</span>
              </div>
              {view === 'markdown' ? <Textarea aria-label="剪藏正文" value={markdown} disabled={busy} onChange={(e) => setMarkdown(e.target.value)} className="min-h-80 rounded-none border-0 font-mono text-[13px]" /> :
                <div className="clip-preview min-h-60 overflow-x-auto p-5 text-[14px] leading-relaxed text-ink [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_p]:my-3 [&_a]:text-accent [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-inset [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2" dangerouslySetInnerHTML={{ __html: html || '<p>保存网页标题与来源链接。</p>' }} />}
            </div>
            <p className="text-[12px] text-ink-4">保存时附上来源网址和剪藏时间。图片保留原站链接，预览中暂不加载。</p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={discard}>丢弃草稿</Button>
              <Button variant="primary" loading={busy} disabled={!repoId || !treeReady || !title.trim()} onClick={save}>保存到知识库</Button>
            </div>
          </div>
        )}
      </PageBody>
    </div>
  )
}
