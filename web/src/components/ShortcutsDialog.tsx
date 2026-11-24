import { Modal, ModalActions, ModalBody, mount } from './dialog'
import { Button, Kbd } from './ui'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

const GROUPS: { title: string; items: { label: string; keys: string[] }[] }[] = [
  {
    title: '全局导航',
    items: [
      { label: '打开全文搜索与命令面板', keys: [MOD, 'K'] },
      { label: '收起 / 展开左侧边栏（专注模式）', keys: [MOD, '\\'] },
      { label: '打开键盘快捷键帮助', keys: ['?'] },
    ],
  },
  {
    title: '文档编辑',
    items: [
      { label: '立即保存并生成版本快照', keys: [MOD, 'S'] },
      { label: '唤起块插入菜单（标题、代码、流程图、画板、嵌入表格）', keys: ['/'] },
      { label: '搜索并双向链接其他文档或多维表格', keys: ['[', '['] },
      { label: '插入提示块（INFO / WARN / SUCCESS / ERROR）', keys: ['>', '[!INFO]'] },
    ],
  },
  {
    title: '多维表格',
    items: [
      { label: '表内搜索高亮', keys: [MOD, 'F'] },
      { label: '撤销 / 重做修改', keys: [MOD, 'Z'] },
      { label: '打开选中记录的详情卡片', keys: ['Space'] },
    ],
  },
]

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="键盘快捷键与输入约定" onClose={onClose} wide className="sm:max-w-[540px]">
      <ModalBody className="flex flex-col gap-5">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="m-0 mb-2 text-[11.5px] font-semibold tracking-wider text-ink-4 uppercase">{g.title}</h3>
            <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface">
              {g.items.map((it) => (
                <div key={it.label} className="flex items-center justify-between gap-4 border-b border-line-subtle px-3.5 py-2.5 text-[12.5px] last:border-b-0">
                  <span className="text-ink-2">{it.label}</span>
                  <Kbd keys={it.keys} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </ModalBody>
      <ModalActions>
        <Button variant="primary" onClick={onClose}>
          知道了
        </Button>
      </ModalActions>
    </Modal>
  )
}

export function openShortcutsDialog() {
  mount((close) => <ShortcutsModal onClose={close} />)
}
