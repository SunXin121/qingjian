import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, formatTime, nodePath, type Doc, type TreeNode } from '../api'
import Backlinks from '../components/Backlinks'
import { confirmDialog, copyText, Modal, ModalActions, ModalBody, mount, openMenu, toast } from '../components/dialog'
import { exportMarkdown } from '../components/ExportDialog'
import {
  IconCamera,
  IconCopy,
  IconDownload,
  IconFolder,
  IconHistory,
  IconList,
  IconMore,
  IconShare,
  IconTrash,
  RepoMark,
} from '../components/icons'
import Outline, { parseHeadings, type Heading } from '../components/Outline'
import { Crumb } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { openShareDialog } from '../components/ShareDialog'
import { Button, cn, EmptyState, IconButton, Loading } from '../components/ui'
import VersionsPanel from '../components/VersionsPanel'
import Editor from '../editor/Editor'
import { setPageMeta } from '../seo'
import { nodeTitle, useStore } from '../store'
import { onThemeModeChange } from '../theme'

const DiffView = lazy(() => import('../components/DiffView'))

type Status = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export default function DocPage() {
  const { repoId, docId } = useParams() as { repoId: string; docId: string }
  return <DocPageInstance key={docId} repoId={repoId} docId={docId} />
}

function DocPageInstance({ repoId, docId }: { repoId: string; docId: string }) {
  const { patchNode, repos, tree, treeRepoId, loadTree } = useStore()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatusState] = useState<Status>('saved')
  const statusRef = useRef<Status>('saved')
  const setStatus = useCallback((s: Status) => {
    statusRef.current = s
    setStatusState(s)
  }, [])
  const [savedAt, setSavedAt] = useState(0)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [stats, setStats] = useState('')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [mountKey, setMountKey] = useState(0)

  const md = useRef('')
  const getMd = useRef<() => string>(() => md.current)
  const savedMd = useRef('')
  const savedTitle = useRef('')
  const titleRef = useRef('')
  const base = useRef(0)
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<number>(0)
  const titleEl = useRef<HTMLTextAreaElement>(null)
  const active = useRef(true)
  const loadRequest = useRef(0)
  const deleted = useRef(false)

  // Ensure the repo tree is loaded so breadcrumbs can resolve parent folders/documents
  useEffect(() => {
    if (treeRepoId !== repoId) loadTree(repoId).catch(() => {})
  }, [repoId, treeRepoId, loadTree])

  const ancestors = useMemo(() => {
    if (treeRepoId !== repoId || !doc?.parent_id) return []
    const byId = new Map(tree.map((n) => [n.id, n]))
    const chain: TreeNode[] = []
    let cur = byId.get(doc.parent_id)
    while (cur && chain.length < 10) {
      chain.unshift(cur)
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return chain.slice(-2)
  }, [tree, treeRepoId, repoId, doc?.parent_id])

  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (deleted.current) return
      const markdown = getMd.current()
      md.current = markdown
      getMd.current = () => markdown
      if (markdown !== savedMd.current || titleRef.current !== savedTitle.current) dirty.current = true
    }
  }, [])

  const load = useCallback(async () => {
    if (!active.current) return
    const request = ++loadRequest.current
    setError('')
    try {
      const d = await api.doc(docId)
      if (!active.current || request !== loadRequest.current) return
      setDoc(d)
      setTitle(d.title)
      titleRef.current = d.title
      md.current = d.markdown
      getMd.current = () => d.markdown
      savedMd.current = d.markdown
      savedTitle.current = d.title
      base.current = d.content_updated_at
      dirty.current = false
      setStatus('saved')
      setSavedAt(d.content_updated_at)
      setHeadings(parseHeadings(d.markdown))
      setStats(d.markdown)
      setMountKey((k) => k + 1)
    } catch (e: any) {
      if (!active.current || request !== loadRequest.current) return
      setError(e instanceof ApiError && e.status === 404 ? '文档不存在或已被删除' : e.message)
    }
  }, [docId, setStatus])

  useEffect(() => {
    setDoc(null)
    setVersionsOpen(false)
    load()
  }, [load])

  const save = useCallback(
    async (opts: { force?: boolean; snapshot?: boolean } = {}) => {
      while (saving.current) await saving.current
      if (deleted.current || (statusRef.current === 'conflict' && !opts.force)) return
      if (!dirty.current && !opts.snapshot) return
      clearTimeout(timer.current)
      dirty.current = false
      const markdown = (md.current = getMd.current())
      const title = titleRef.current
      setHeadings(parseHeadings(markdown))
      setStats(markdown)
      if (markdown === savedMd.current && title === savedTitle.current && !opts.snapshot && !opts.force) {
        setStatus('saved')
        return
      }
      setStatus('saving')
      const body = { markdown, title, base_updated_at: base.current, ...opts }
      const p = api
        .saveDoc(docId, body)
        .then((r) => {
          savedMd.current = markdown
          savedTitle.current = title
          base.current = r.updated_at
          setSavedAt(r.updated_at)
          patchNode(docId, { title: r.title, updated_at: r.updated_at })
          setStatus(dirty.current ? 'dirty' : 'saved')
        })
        .catch((e) => {
          dirty.current = true
          if (e instanceof ApiError && e.status === 409) setStatus('conflict')
          else {
            setStatus('error')
            timer.current = window.setTimeout(() => save(), 5000)
          }
        })
        .finally(() => {
          saving.current = null
        })
      saving.current = p
      await p
    },
    [docId, patchNode, setStatus],
  )

  const schedule = useCallback(() => {
    dirty.current = true
    if (statusRef.current === 'conflict') return
    setStatus('dirty')
    clearTimeout(timer.current)
    const delay = md.current.length > 200_000 ? 3000 : 1000
    timer.current = window.setTimeout(() => {
      if (statusRef.current !== 'conflict') save()
    }, delay)
  }, [save, setStatus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save({ snapshot: true }).then(() => toast('已保存'))
      }
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden' && dirty.current && statusRef.current !== 'conflict') save()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      clearTimeout(timer.current)
      if (dirty.current && statusRef.current !== 'conflict') save()
    }
  }, [save])

  useEffect(() => {
    if (doc) setPageMeta({ title: `${title.trim() || '无标题文档'} - 青简` })
  }, [title, doc])

  useEffect(
    () =>
      onThemeModeChange(() => {
        if (statusRef.current !== 'conflict') save().then(load)
      }),
    [save, load],
  )

  useEffect(() => {
    const el = titleEl.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }, [title, doc])

  const onChange = useCallback(
    (get: () => string) => {
      getMd.current = get
      schedule()
    },
    [schedule],
  )

  const showConflictDiff = async () => {
    try {
      const remote = await api.doc(docId)
      const local = getMd.current()
      mount((close) => (
        <Modal title="与服务器上的版本对比" onClose={close} wide className="sm:max-w-[880px]">
          <ModalBody className="conflict-diff p-0">
            <Suspense fallback={<Loading />}>
              <DiffView oldText={remote.markdown} newText={local} oldLabel="服务器上的版本" newLabel="当前窗口的内容" />
            </Suspense>
          </ModalBody>
          <ModalActions>
            <Button onClick={close}>关闭</Button>
          </ModalActions>
        </Modal>
      ))
    } catch (e: any) {
      toast(e.message)
    }
  }
  const repo = repos.find((r) => r.id === repoId)

  const share = () => openShareDialog({ target_type: 'node', target_id: docId, title: titleRef.current || '无标题文档' })

  const copyMarkdown = () => {
    const heading = titleRef.current.trim() || '无标题文档'
    const body = getMd.current().trim()
    void copyText(body ? `# ${heading}\n\n${body}\n` : `# ${heading}\n`, '已复制 Markdown 原文')
  }

  const more = (el: HTMLElement) =>
    openMenu(el, [
      { label: '分享文档', icon: <IconShare />, onClick: share },
      { label: '复制 Markdown 原文', icon: <IconCopy />, onClick: copyMarkdown },
      {
        label: '导出 Markdown 文件',
        icon: <IconDownload />,
        onClick: async () => {
          await save()
          await exportMarkdown('doc', docId)
        },
      },
      { label: '保存版本快照', icon: <IconCamera />, onClick: () => save({ snapshot: true }).then(() => toast('已保存快照')) },
      {
        label: '删除文档',
        icon: <IconTrash />,
        danger: true,
        divider: true,
        onClick: async () => {
          if (!(await confirmDialog('确定删除这篇文档及其子文档吗？可在回收站中恢复。', { danger: true, okText: '删除' }))) return
          dirty.current = false
          await api.deleteNode(docId)
          deleted.current = true
          await loadTree(repoId)
          navigate(`/r/${repoId}`)
        },
      },
    ])

  if (error) {
    return (
      <div>
        <PageHeader />
        <main id="main-content">
          <EmptyState title="打不开这篇文档">{error}</EmptyState>
        </main>
      </div>
    )
  }
  if (!doc)
    return (
      <div>
        <PageHeader />
        <main id="main-content">
          <Loading />
        </main>
      </div>
    )

  const statusText: Record<Status, string> = {
    saved: savedAt ? `已保存 · ${formatTime(savedAt)}` : '已保存',
    dirty: '编辑中…',
    saving: '保存中…',
    error: '保存失败，稍后重试',
    conflict: '存在冲突',
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <PageHeader>
        <Crumbs>
          <Crumb to={`/r/${repoId}`} icon={repo && <RepoMark repo={repo} size={18} />}>
            {repo?.name}
          </Crumb>
          {ancestors.map((anc) =>
            anc.type === 'group' ? (
              <span key={anc.id} className="inline-flex max-w-[140px] items-center gap-1 truncate text-ink-3 max-lg:hidden">
                <IconFolder width={13} height={13} className="shrink-0 text-ink-4" />
                <span className="truncate">{nodeTitle(anc)}</span>
                <span className="px-0.5 text-ink-4">/</span>
              </span>
            ) : (
              <span key={anc.id} className="contents max-lg:hidden">
                <Crumb to={nodePath(anc)}>{nodeTitle(anc)}</Crumb>
              </span>
            ),
          )}
          <Crumb current>{title.trim() || '无标题文档'}</Crumb>
          <SaveState status={status} label={statusText[status]} />
        </Crumbs>
        {headings.length > 0 && (
          <IconButton label="文档大纲" className="xl:hidden" active={outlineOpen} onClick={() => setOutlineOpen((v) => !v)}>
            <IconList width={16} height={16} />
          </IconButton>
        )}
        <IconButton label="复制 Markdown" className="max-md:hidden" onClick={copyMarkdown}>
          <IconCopy width={15} height={15} />
        </IconButton>
        <IconButton label="分享文档" className="max-md:hidden" onClick={share}>
          <IconShare width={16} height={16} />
        </IconButton>
        <IconButton
          label="历史版本"
          onClick={async () => {
            await save()
            setVersionsOpen(true)
          }}
        >
          <IconHistory width={16} height={16} />
        </IconButton>
        <IconButton label="更多操作" onClick={(e) => more(e.currentTarget)}>
          <IconMore width={16} height={16} />
        </IconButton>
      </PageHeader>

      {status === 'conflict' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_10%,var(--bg-editor))] px-4 py-2.5 text-[12.5px] text-ink md:px-6"
        >
          <span className="mr-auto font-medium">这篇文档在其他窗口或设备上被修改过。</span>
          <Button size="sm" onClick={showConflictDiff}>
            查看差异
          </Button>
          <Button size="sm" onClick={load}>
            放弃本地修改并加载最新
          </Button>
          <Button size="sm" variant="danger" onClick={() => save({ force: true })}>
            用当前内容覆盖
          </Button>
        </div>
      )}

      <div className="flex flex-1 items-start">
        <main id="main-content" data-doc-id={doc.id} data-save-status={status} className="doc-main min-w-0 flex-1">
          <article className="mx-auto w-full max-w-[calc(var(--prose-width)+128px)] px-5 pt-8 pb-[30vh] md:px-16 md:pt-14">
            <textarea
              ref={titleEl}
              aria-label="文档标题"
              className="mb-4 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[28px] leading-[1.3] font-bold tracking-[-0.015em] text-ink outline-none placeholder:text-ink-4 focus-visible:outline-none md:mb-5 md:text-[34px]"
              style={{ fontFamily: 'var(--prose-font)' }}
              rows={1}
              value={title}
              placeholder="无标题文档"
              onChange={(e) => {
                const v = e.target.value.replace(/\n/g, '')
                setTitle(v)
                titleRef.current = v
                schedule()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  ;(document.querySelector('.doc-main .ProseMirror') as HTMLElement | null)?.focus()
                }
              }}
            />
            <Editor
              key={doc.id + ':' + mountKey}
              value={doc.markdown}
              onChange={onChange}
              onReady={({ getMarkdown }) => {
                getMd.current = getMarkdown
              }}
            />
            <Backlinks nodeId={doc.id} repoId={repoId} />
          </article>
        </main>
        <Outline headings={headings} open={outlineOpen} onClose={() => setOutlineOpen(false)} />
      </div>

      <DocStats markdown={stats} headingCount={headings.length} updatedAt={savedAt} />

      {versionsOpen && (
        <VersionsPanel
          docId={docId}
          current={{ title: titleRef.current, markdown: getMd.current() }}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => {
            setVersionsOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}

function SaveState({ status, label }: { status: Status; label: string }) {
  const tone =
    status === 'saved' ? 'bg-success' : status === 'conflict' || status === 'error' ? 'bg-danger' : status === 'saving' ? 'bg-accent animate-pulse' : 'bg-warning'
  return (
    <span className="ml-2 inline-flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-4" role="status" aria-live="polite">
      <span className={cn('size-1.5 rounded-full transition-colors duration-(--dur-base)', tone)} />
      <span className="max-sm:hidden">{label}</span>
    </span>
  )
}

function countWords(md: string) {
  const text = md
    .replace(/```(excalidraw|drawio|mindmap)\n[\s\S]*?\n```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, '')
    .replace(/[#>*_`~|[\]-]/g, ' ')
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9\u00C0-\u024F]+(?:['’.-][A-Za-z0-9]+)*/g)?.length ?? 0
  const chars = text.replace(/\s/g, '').length
  return { words: cjk + latin, chars }
}

function DocStats({ markdown, headingCount, updatedAt }: { markdown: string; headingCount: number; updatedAt: number }) {
  const { words, chars } = useMemo(() => countWords(markdown), [markdown])
  const minutes = Math.max(1, Math.round(words / 400))
  return (
    <footer
      aria-label="文档统计信息"
      className="tabular sticky bottom-0 z-15 flex h-[calc(var(--statusbar-h)+var(--safe-b))] items-center gap-4 border-t border-line-subtle bg-[color-mix(in_oklab,var(--bg-editor)_88%,transparent)] px-4 pb-(--safe-b) text-[11.5px] whitespace-nowrap text-ink-4 backdrop-blur-md md:px-5"
    >
      <span>{words.toLocaleString()} 字</span>
      <span>{chars.toLocaleString()} 字符</span>
      <span>约 {minutes} 分钟读完</span>
      {headingCount > 0 && <span className="max-sm:hidden">{headingCount} 节</span>}
      <span className="flex-1" />
      {updatedAt > 0 && <span className="max-md:hidden">更新于 {new Date(updatedAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
    </footer>
  )
}
