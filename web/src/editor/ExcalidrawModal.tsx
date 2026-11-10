import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { uploadFile } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { parseDrawing, prefersDark } from './previews'

type ExcalidrawModule = typeof import('@excalidraw/excalidraw')

let modP: Promise<ExcalidrawModule> | null = null
function loadExcalidraw() {
  ;(window as any).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'
  modP ??= Promise.all([import('@excalidraw/excalidraw'), import('@excalidraw/excalidraw/index.css')]).then(([m]) => m)
  return modP
}

const sceneSignature = (elements: readonly any[]) =>
  elements
    .filter((e) => !e.isDeleted)
    .map((e) => `${e.id}:${e.version}`)
    .join(',')

interface Props {
  content: string
  onSave: (newContent: string) => void
  onClose: () => void
}

export default function ExcalidrawModal({ content, onSave, onClose }: Props) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null)
  const [initial, setInitial] = useState<any>(undefined)
  const [saving, setSaving] = useState(false)
  const apiRef = useRef<any>(null)
  // signature of the scene when it was loaded; compared on close to detect real edits
  // (Excalidraw fires onChange several times while mounting, so counting calls is unreliable)
  const baseline = useRef<string | null>(null)
  const dirty = useRef(false)

  useEffect(() => {
    let alive = true
    const ref = parseDrawing(content)
    Promise.all([
      loadExcalidraw(),
      ref.scene
        ? fetch(`/files/${ref.scene}/scene.excalidraw`).then((r) => (r.ok ? r.json() : null))
        : Promise.resolve(null),
    ])
      .then(([m, scene]) => {
        if (!alive) return
        setInitial(
          scene
            ? { elements: scene.elements ?? [], appState: { ...(scene.appState ?? {}), collaborators: new Map() }, files: scene.files ?? {} }
            : { elements: [], appState: {} },
        )
        setMod(m)
      })
      .catch((e) => {
        toast('画板加载失败：' + e.message)
        onClose()
      })
    return () => {
      alive = false
    }
  }, [content])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const close = async () => {
    if (dirty.current && !(await confirmDialog('画板有未保存的修改，确定放弃吗？', { danger: true, okText: '放弃' }))) return
    onClose()
  }

  const save = async () => {
    const api = apiRef.current
    if (!api || !mod) return
    setSaving(true)
    try {
      const elements = api.getSceneElements()
      const appState = api.getAppState()
      const files = api.getFiles()
      const svg = await mod.exportToSvg({
        elements,
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        files,
        exportPadding: 16,
      })
      const svgText = new XMLSerializer().serializeToString(svg)
      const json = mod.serializeAsJSON(elements, appState, files, 'local')
      const [scene, image] = await Promise.all([
        uploadFile(new Blob([json], { type: 'application/json' }), 'scene.excalidraw'),
        uploadFile(new Blob([svgText], { type: 'image/svg+xml' }), 'drawing.svg'),
      ])
      onSave(JSON.stringify({ scene: scene.id, svg: image.id }))
      onClose()
    } catch (e: any) {
      toast('保存失败：' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const Excalidraw = mod?.Excalidraw
  return createPortal(
    <div className="ink-board-modal">
      <div className="ink-board-bar">
        <span className="ink-board-title">画板</span>
        <span className="spacer" />
        <button className="btn" onClick={close} disabled={saving}>
          取消
        </button>
        <button className="btn primary" onClick={save} disabled={saving || !mod}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <div className="ink-board-canvas">
        {Excalidraw && initial ? (
          <Excalidraw
            initialData={initial}
            excalidrawAPI={(api: any) => (apiRef.current = api)}
            onChange={(elements: readonly any[]) => {
              const sig = sceneSignature(elements)
              if (baseline.current === null) baseline.current = sig
              else if (sig !== baseline.current) dirty.current = true
            }}
            langCode="zh-CN"
            theme={prefersDark() ? 'dark' : 'light'}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
          />
        ) : (
          <div className="ink-loading">正在加载画板…</div>
        )}
      </div>
    </div>,
    document.body,
  )
}
