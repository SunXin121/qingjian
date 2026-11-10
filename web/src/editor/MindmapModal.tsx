import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { uploadFile } from '../api'
import { confirmDialog, toast } from '../components/dialog'
import { DRAWINGS, dataURLToText, parseDrawing } from './previews'

type MindMapModule = { default: any }

let modP: Promise<any> | null = null
function loadMindMap() {
  modP ??= Promise.all([
    import('simple-mind-map') as Promise<MindMapModule>,
    import('simple-mind-map/src/plugins/Drag.js') as Promise<MindMapModule>,
    import('simple-mind-map/src/plugins/Select.js') as Promise<MindMapModule>,
    import('simple-mind-map/src/plugins/Export.js') as Promise<MindMapModule>,
    import('simple-mind-map/src/plugins/KeyboardNavigation.js') as Promise<MindMapModule>,
    import('simple-mind-map/src/plugins/TouchEvent.js') as Promise<MindMapModule>,
  ]).then(([core, ...plugins]) => {
    const MindMap = core.default
    for (const p of plugins) MindMap.usePlugin(p.default)
    return MindMap
  })
  return modP
}

const LAYOUTS: [string, string][] = [
  ['logicalStructure', '逻辑结构图'],
  ['mindMap', '思维导图'],
  ['organizationStructure', '组织结构图'],
  ['catalogOrganization', '目录组织图'],
  ['timeline', '时间轴'],
  ['fishbone', '鱼骨图'],
]

const NEW_MAP = {
  layout: 'logicalStructure',
  root: {
    data: { text: '中心主题' },
    children: [
      { data: { text: '分支主题 1' }, children: [] },
      { data: { text: '分支主题 2' }, children: [] },
      { data: { text: '分支主题 3' }, children: [] },
    ],
  },
}

interface Props {
  content: string
  onSave: (newContent: string) => void
  onClose: () => void
}

export default function MindmapModal({ content, onSave, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const changes = useRef(0)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [layout, setLayout] = useState('logicalStructure')
  const [hasActive, setHasActive] = useState(false)

  useEffect(() => {
    let alive = true
    const ref = parseDrawing(content)
    Promise.all([
      loadMindMap(),
      ref.scene ? fetch(`/files/${ref.scene}/${DRAWINGS.mindmap.sceneName}`).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null),
    ])
      .then(([MindMap, saved]) => {
        if (!alive || !host.current) return
        const data = saved?.root ? saved : NEW_MAP
        const map = new MindMap({
          el: host.current,
          data: data.root,
          layout: data.layout || 'logicalStructure',
          theme: data.theme?.template || 'default',
          themeConfig: data.theme?.config || {},
          viewData: data.view,
          fit: !data.view,
          mousewheelAction: 'zoom',
          exportPaddingX: 24,
          exportPaddingY: 24,
          defaultInsertSecondLevelNodeText: '分支主题',
          defaultInsertBelowSecondLevelNodeText: '子主题',
        })
        setLayout(data.layout || 'logicalStructure')
        map.on('data_change', () => changes.current++)
        map.on('node_active', (_: unknown, list: unknown[]) => setHasActive(list.length > 0))
        mapRef.current = map
        setReady(true)
      })
      .catch((e) => {
        toast('思维导图加载失败：' + e.message)
        onClose()
      })
    return () => {
      alive = false
      mapRef.current?.destroy()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const cmd = (name: string) => mapRef.current?.execCommand(name)
  const editText = () => {
    const map = mapRef.current
    const node = map?.renderer.activeNodeList[0]
    if (node) map.renderer.textEdit.show({ node })
  }

  const close = async () => {
    if (changes.current > 0 && !(await confirmDialog('思维导图有未保存的修改，确定放弃吗？', { danger: true, okText: '放弃' }))) return
    onClose()
  }

  const save = async () => {
    const map = mapRef.current
    if (!map) return
    setSaving(true)
    try {
      map.renderer.textEdit.hideEditTextBox()
      const data = map.getData(true)
      const svg = dataURLToText(await map.export('svg', false, DRAWINGS.mindmap.label))
      const [scene, image] = await Promise.all([
        uploadFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), DRAWINGS.mindmap.sceneName),
        uploadFile(new Blob([svg], { type: 'image/svg+xml' }), DRAWINGS.mindmap.svgName),
      ])
      onSave(JSON.stringify({ scene: scene.id, svg: image.id }))
      onClose()
    } catch (e: any) {
      toast('保存失败：' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="ink-board-modal">
      <div className="ink-board-bar">
        <span className="ink-board-title">思维导图</span>
        <span className="spacer" />
        <button className="btn" onClick={close} disabled={saving}>
          取消
        </button>
        <button className="btn primary" onClick={save} disabled={saving || !ready}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <div className="mindmap-tools">
        <button className="btn sm" disabled={!hasActive} onClick={() => cmd('INSERT_CHILD_NODE')} title="Tab">
          子主题
        </button>
        <button className="btn sm" disabled={!hasActive} onClick={() => cmd('INSERT_NODE')} title="Enter">
          同级主题
        </button>
        <button className="btn sm" disabled={!hasActive} onClick={editText} title="F2 / 双击">
          编辑文字
        </button>
        <button className="btn sm" disabled={!hasActive} onClick={() => cmd('REMOVE_NODE')} title="Delete">
          删除
        </button>
        <span className="tool-sep" />
        <button className="btn sm" onClick={() => cmd('BACK')} title="Ctrl+Z">
          撤销
        </button>
        <button className="btn sm" onClick={() => cmd('FORWARD')} title="Ctrl+Y">
          重做
        </button>
        <span className="tool-sep" />
        <select
          value={layout}
          onChange={(e) => {
            setLayout(e.target.value)
            mapRef.current?.setLayout(e.target.value)
          }}
        >
          {LAYOUTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={() => mapRef.current?.view.fit()}>
          适应画布
        </button>
        <span className="mindmap-hint">点击选中 · 双击编辑 · Tab 子主题 · Enter 同级 · 拖拽调整</span>
      </div>
      <div className="ink-board-canvas mindmap-canvas">
        <div ref={host} className="mindmap-host" />
        {!ready && <div className="ink-loading mindmap-loading">正在加载思维导图…</div>}
      </div>
    </div>,
    document.body,
  )
}
