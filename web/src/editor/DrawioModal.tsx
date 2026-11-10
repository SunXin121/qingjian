import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getConfig, uploadFile } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { DRAWINGS, dataURLToText, parseDrawing, prefersDark } from './previews'

interface Props {
  content: string
  onSave: (newContent: string) => void
  onClose: () => void
}

/**
 * draw.io in embed mode (https://www.drawio.com/doc/faq/embed-mode), talking JSON over
 * postMessage. The editable XML and an SVG preview are stored as two attachments.
 */
export default function DrawioModal({ content, onSave, onClose }: Props) {
  const [src, setSrc] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    getConfig()
      .then((c) => {
        const u = new URL(c.drawio_url, location.href)
        const p = u.searchParams
        p.set('embed', '1')
        p.set('proto', 'json')
        p.set('spin', '1')
        p.set('lang', 'zh')
        p.set('saveAndExit', '1')
        p.set('noExitBtn', '0')
        p.set('libraries', '1')
        p.set('dark', prefersDark() ? '1' : '0')
        setSrc(u.toString())
      })
      .catch((e) => {
        toast('无法加载 draw.io 配置：' + e.message)
        closeRef.current()
      })
  }, [])

  useEffect(() => {
    if (!src) return
    const origin = new URL(src).origin
    const ref = parseDrawing(content)
    const xmlP: Promise<string> = ref.scene
      ? fetch(`/files/${ref.scene}/${DRAWINGS.drawio.sceneName}`).then((r) => (r.ok ? r.text() : ''))
      : Promise.resolve('')
    let exitAfterSave = false
    let templateShown = false
    let pendingXml = ''
    const post = (msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(msg), origin)

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return
      let msg: any
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      switch (msg.event) {
        case 'init':
          setReady(true)
          post({ action: 'load', xml: await xmlP, autosave: 0, title: DRAWINGS.drawio.label })
          break
        case 'load':
          // a new diagram starts from draw.io's template library (flowchart, UML, ER, ...);
          // cancelling it leaves a blank canvas instead of closing the editor
          if (!ref.scene && !templateShown) {
            templateShown = true
            post({ action: 'template', noExitOnCancel: 1 })
          }
          break
        case 'save':
          exitAfterSave = !!msg.exit
          pendingXml = msg.xml
          post({ action: 'export', format: 'xmlsvg', xml: msg.xml, spinKey: 'saving' })
          break
        case 'export': {
          setSaving(true)
          try {
            const svg = dataURLToText(msg.data)
            const xml = msg.xml || pendingXml
            const [scene, image] = await Promise.all([
              uploadFile(new Blob([xml], { type: 'application/xml' }), DRAWINGS.drawio.sceneName),
              uploadFile(new Blob([svg], { type: 'image/svg+xml' }), DRAWINGS.drawio.svgName),
            ])
            saveRef.current(JSON.stringify({ scene: scene.id, svg: image.id }))
            post({ action: 'spinner', show: false })
            post({ action: 'status', message: '已保存', modified: false })
            if (exitAfterSave) closeRef.current()
          } catch (err: any) {
            post({ action: 'spinner', show: false })
            toast('保存失败：' + err.message)
          } finally {
            setSaving(false)
          }
          break
        }
        case 'exit':
          if (msg.modified && !(await confirmDialog('流程图有未保存的修改，确定放弃吗？', { danger: true, okText: '放弃' }))) return
          closeRef.current()
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [src, content])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  return createPortal(
    <div className="ink-board-modal drawio-modal">
      {src ? (
        <iframe ref={frame} src={src} title="draw.io" className="drawio-frame" />
      ) : (
        <div className="ink-loading">正在加载 draw.io…</div>
      )}
      {saving && <div className="drawio-saving">保存中…</div>}
      {!ready && (
        <button className="btn sm drawio-close" onClick={() => closeRef.current()}>
          取消
        </button>
      )}
    </div>,
    document.body,
  )
}
