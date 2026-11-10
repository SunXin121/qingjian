import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import type { Ctx } from '@milkdown/kit/ctx'
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core'
import { uploadConfig, type Uploader } from '@milkdown/kit/plugin/upload'
import { clearTextInCurrentBlockCommand, codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { uploadFile } from '../api'
import { toast } from '../components/dialog'
import { calloutPlugin, insertCallout, normalizeCalloutMarkdown } from './callout'
import { DIAGRAM_TEMPLATES, isDrawingKind, prefersDark, renderPreview, type DrawingKind } from './previews'

const ExcalidrawModal = lazy(() => import('./ExcalidrawModal'))
const DrawioModal = lazy(() => import('./DrawioModal'))
const MindmapModal = lazy(() => import('./MindmapModal'))

const MODALS = { excalidraw: ExcalidrawModal, drawio: DrawioModal, mindmap: MindmapModal }

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
const ICONS = {
  mermaid: icon('<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v4h11v4"/>'),
  graphviz: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7"/>'),
  board: icon('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'),
  math: icon('<path d="M5 5h14M5 5l7 7-7 7h14"/>'),
  file: icon('<path d="M20 11.5l-8.2 8.2a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8"/>'),
  drawio: icon('<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><path d="M9 6h6M18 9v6"/>'),
  mindmap: icon('<circle cx="12" cy="12" r="2.5"/><circle cx="4.5" cy="6" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/><circle cx="19.5" cy="6" r="1.5"/><circle cx="19.5" cy="18" r="1.5"/><path d="M9.8 10.7L6 7M9.8 13.3L6 17M14.2 10.7L18 7M14.2 13.3L18 17"/>'),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  warn: icon('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
  success: icon('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
  error: icon('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  fold: icon('<path d="M4 6h16M4 12h10M4 18h10"/><path d="M17 14l2 2 2-2"/>'),
}

export interface EditorHandle {
  getMarkdown: () => string
}

interface Props {
  value: string
  readonly?: boolean
  onChange?: (markdown: string) => void
  onReady?: (h: EditorHandle) => void
}

/**
 * Replace the current (empty) block with a code block of the given language, followed by
 * an empty paragraph that receives the cursor — diagram blocks show only their preview,
 * so leaving the cursor inside the hidden code editor would swallow further typing.
 */
function insertCodeBlock(ctx: Ctx, language: string, content: string) {
  const commands = ctx.get(commandsCtx)
  commands.call(clearTextInCurrentBlockCommand.key)
  const view = ctx.get(editorViewCtx)
  const { state } = view
  const { $from } = state.selection
  const { schema } = state
  const node = codeBlockSchema.type(ctx).create({ language }, content ? schema.text(content) : undefined)
  const start = $from.before()
  const tr = state.tr.replaceWith(start, $from.after(), [node, schema.nodes.paragraph.create()])
  const paraPos = start + node.nodeSize + 1
  tr.setSelection(TextSelection.create(tr.doc, paraPos))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  if (isDrawingKind(language)) return
  // Freshly inserted diagram/math blocks open in "code + live preview" mode.
  // Retry for a moment: async previews (mermaid/graphviz) render the toggle button late.
  let tries = 0
  const openEditor = () => {
    const dom = view.nodeDOM(start) as HTMLElement | null
    const btn = dom?.querySelector<HTMLButtonElement>('.preview-toggle-button')
    const host = dom?.querySelector('.codemirror-host')
    if (btn && host?.classList.contains('hidden')) {
      btn.click()
      setTimeout(() => dom?.querySelector<HTMLElement>('.cm-content')?.focus(), 30)
    } else if (!btn && tries++ < 40) {
      setTimeout(openEditor, 50)
    }
  }
  setTimeout(openEditor, 0)
}

function pickFiles(accept = '*/*', multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    // must be in the DOM for some mobile browsers to open the picker
    document.body.appendChild(input)
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    input.addEventListener('cancel', () => input.remove())
    input.click()
  })
}

async function uploadWithToast(file: File) {
  try {
    return await uploadFile(file)
  } catch (e: any) {
    toast(`「${file.name}」上传失败：${e.message}`)
    throw e
  }
}

export default function Editor({ value, readonly, onChange, onReady }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [drawing, setDrawing] = useState<{ kind: DrawingKind; content: string } | null>(null)

  useEffect(() => {
    const root = rootRef.current!
    let destroyed = false

    const crepe = new Crepe({
      root,
      defaultValue: value,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: '输入 / 唤起菜单，支持 Markdown 语法', mode: 'block' },
        [Crepe.Feature.CodeMirror]: {
          theme: prefersDark() ? oneDark : [],
          renderPreview,
          previewOnlyByDefault: true,
          searchPlaceholder: '搜索语言',
          noResultText: '没有匹配的语言',
          copyText: '复制',
          previewLabel: '预览',
          previewToggleText: (previewOnly) => (previewOnly ? '编辑' : '收起'),
          onCopy: () => toast('已复制'),
          previewLoading: '<div class="ink-preview-hint">渲染中…</div>',
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file) => (await uploadWithToast(file)).url,
          blockUploadButton: '上传图片',
          blockUploadPlaceholderText: '或粘贴图片链接',
          blockCaptionPlaceholderText: '添加图片说明',
          blockConfirmButton: '确定',
          inlineUploadButton: '上传',
          inlineUploadPlaceholderText: '或粘贴链接',
          inlineConfirmButton: '确定',
        },
        [Crepe.Feature.LinkTooltip]: {
          inputPlaceholder: '粘贴或输入链接…',
          onCopyLink: () => toast('链接已复制'),
        },
        [Crepe.Feature.Toolbar]: {
          boldLabel: '粗体',
          italicLabel: '斜体',
          strikethroughLabel: '删除线',
          codeLabel: '行内代码',
          linkLabel: '链接',
          latexLabel: '行内公式',
        },
        [Crepe.Feature.Latex]: { inlineEditConfirm: '确定' },
        [Crepe.Feature.BlockEdit]: {
          textGroup: {
            label: '基础',
            text: { label: '正文 Text' },
            h1: { label: '一级标题 H1' },
            h2: { label: '二级标题 H2' },
            h3: { label: '三级标题 H3' },
            h4: { label: '四级标题 H4' },
            h5: { label: '五级标题 H5' },
            h6: { label: '六级标题 H6' },
            quote: { label: '引用 Quote' },
            divider: { label: '分割线 Divider' },
          },
          listGroup: {
            label: '列表',
            bulletList: { label: '无序列表 Bullet' },
            orderedList: { label: '有序列表 Ordered' },
            taskList: { label: '任务列表 Todo' },
          },
          advancedGroup: {
            label: '插入',
            image: { label: '图片 Image' },
            codeBlock: { label: '代码块 Code' },
            table: { label: '表格 Table' },
            math: null,
          },
          buildMenu: (builder) => {
            builder.getGroup('advanced').addItem('math', {
              label: '公式 Math LaTeX',
              icon: ICONS.math,
              onRun: (ctx: Ctx) => insertCodeBlock(ctx, 'LaTeX', 'E = mc^2'),
            })
            builder
              .addGroup('drawing', '绘图')
              .addItem('mermaid', {
                label: '文本绘图 Mermaid',
                icon: ICONS.mermaid,
                onRun: (ctx) => insertCodeBlock(ctx, 'mermaid', DIAGRAM_TEMPLATES.mermaid),
              })
              .addItem('graphviz', {
                label: '文本绘图 Graphviz DOT',
                icon: ICONS.graphviz,
                onRun: (ctx: Ctx) => insertCodeBlock(ctx, 'dot', DIAGRAM_TEMPLATES.dot),
              })
              .addItem('excalidraw', {
                label: '画板 Excalidraw 手绘',
                icon: ICONS.board,
                onRun: (ctx: Ctx) => newDrawing(ctx, 'excalidraw'),
              })
              .addItem('drawio', {
                label: '流程图 draw.io',
                icon: ICONS.drawio,
                onRun: (ctx: Ctx) => newDrawing(ctx, 'drawio'),
              })
              .addItem('mindmap', {
                label: '思维导图 Mind map',
                icon: ICONS.mindmap,
                onRun: (ctx: Ctx) => newDrawing(ctx, 'mindmap'),
              })
            builder
              .addGroup('callout', '提示块')
              .addItem('callout-info', { label: '信息 Info', icon: ICONS.info, onRun: (ctx: Ctx) => insertCallout(ctx, 'INFO') })
              .addItem('callout-warn', { label: '警告 Warning', icon: ICONS.warn, onRun: (ctx: Ctx) => insertCallout(ctx, 'WARNING') })
              .addItem('callout-success', { label: '成功 Success', icon: ICONS.success, onRun: (ctx: Ctx) => insertCallout(ctx, 'SUCCESS') })
              .addItem('callout-error', { label: '错误 Error', icon: ICONS.error, onRun: (ctx: Ctx) => insertCallout(ctx, 'ERROR') })
              .addItem('fold', { label: '折叠块 Fold', icon: ICONS.fold, onRun: (ctx: Ctx) => insertCallout(ctx, 'FOLD') })
            builder.addGroup('file', '文件').addItem('attachment', {
              label: '附件 Attachment',
              icon: ICONS.file,
              onRun: (ctx) => {
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
                pickFiles().then((files) => insertFiles(files))
              },
            })
          },
        },
      },
    })

    function newDrawing(ctx: Ctx, kind: DrawingKind) {
      const content = JSON.stringify({ new: Math.random().toString(36).slice(2, 10) })
      insertCodeBlock(ctx, kind, content)
      setDrawing({ kind, content })
    }

    crepe.editor.use(calloutPlugin)

    // Upload pasted / dropped files to the server instead of inlining base64.
    const uploader: Uploader = async (files, schema) => {
      const list = Array.from(files)
      const nodes: PMNode[] = []
      for (const file of list) {
        try {
          const att = await uploadWithToast(file)
          if (file.type.startsWith('image/')) {
            nodes.push(schema.nodes.image.create({ src: att.url, alt: file.name }))
          } else {
            nodes.push(schema.text(`📎 ${att.name}`, [schema.marks.link.create({ href: att.url })]))
            nodes.push(schema.text(' '))
          }
        } catch {
          /* toast already shown */
        }
      }
      return nodes
    }
    crepe.editor.config((ctx) => {
      ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader, enableHtmlFileUploader: false }))
    })

    async function insertFiles(files: File[]) {
      for (const file of files) {
        let att
        try {
          att = await uploadWithToast(file)
        } catch {
          continue
        }
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { state } = view
          const { schema } = state
          const isImage = file.type.startsWith('image/')
          const inline = isImage
            ? schema.nodes.image.create({ src: att.url, alt: file.name })
            : schema.text(`📎 ${att.name}`, [schema.marks.link.create({ href: att.url })])
          view.dispatch(state.tr.replaceSelectionWith(inline, false).scrollIntoView())
          view.focus()
        })
      }
    }

    crepe.on((api) => {
      api.markdownUpdated((_ctx, md, prev) => {
        if (md !== prev) onChangeRef.current?.(normalizeCalloutMarkdown(md))
      })
    })

    if (readonly) crepe.setReadonly(true)

    // Crepe hides the native caret and draws a "virtual cursor" that it only re-measures on
    // view updates and `selectionchange`. When focus comes back from a drawing modal / dialog
    // the restored selection often fires neither, leaving the caret invisible (or at a stale
    // spot). Re-measure on every focus by dispatching an empty transaction.
    let offFocus = () => {}
    const created = crepe.create().then(() => {
      if (destroyed) return
      crepeRef.current = crepe
      const view = crepe.editor.ctx.get(editorViewCtx)
      const refreshCursor = () =>
        requestAnimationFrame(() => {
          if (!view.isDestroyed && view.hasFocus()) view.dispatch(view.state.tr)
        })
      view.dom.addEventListener('focus', refreshCursor)
      offFocus = () => view.dom.removeEventListener('focus', refreshCursor)
      onReady?.({ getMarkdown: () => normalizeCalloutMarkdown(crepe.getMarkdown()) })
    })

    // click on a drawing preview opens the board editor
    const onClick = (e: MouseEvent) => {
      if (crepe.readonly) return
      const el = (e.target as Element).closest?.('[data-ink-drawing]')
      const kind = el?.getAttribute('data-ink-kind') ?? 'excalidraw'
      if (el && isDrawingKind(kind)) {
        e.preventDefault()
        setDrawing({ kind, content: el.getAttribute('data-ink-drawing') ?? '' })
      }
    }
    root.addEventListener('click', onClick)

    return () => {
      destroyed = true
      offFocus()
      root.removeEventListener('click', onClick)
      crepeRef.current = null
      created.finally(() => crepe.destroy())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveDrawing = (kind: DrawingKind, oldContent: string, newContent: string) => {
    const crepe = crepeRef.current
    if (!crepe) return
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let target = -1
      let size = 0
      view.state.doc.descendants((node, pos) => {
        if (target >= 0) return false
        if (node.type.name === 'code_block' && node.attrs.language === kind && node.textContent === oldContent) {
          target = pos
          size = node.content.size
          return false
        }
        return true
      })
      if (target < 0) return toast('找不到对应的绘图块，可能已被删除')
      view.dispatch(view.state.tr.replaceWith(target + 1, target + 1 + size, view.state.schema.text(newContent)))
    })
  }

  return (
    <>
      <div ref={rootRef} className={'ink-editor' + (readonly ? ' readonly' : '')} />
      {drawing !== null &&
        (() => {
          const Modal = MODALS[drawing.kind]
          return (
            <Suspense fallback={null}>
              <Modal
                content={drawing.content}
                onSave={(c: string) => {
                  saveDrawing(drawing.kind, drawing.content, c)
                  // later saves from the same modal (draw.io keeps its window open) must find the updated block
                  setDrawing((d) => (d ? { ...d, content: c } : d))
                }}
                onClose={() => {
                  setDrawing(null)
                  // focus after the modal has unmounted and the page scrollbar is back,
                  // so the caret is measured against the final layout
                  requestAnimationFrame(() => crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus()))
                }}
              />
            </Suspense>
          )
        })()}
    </>
  )
}
