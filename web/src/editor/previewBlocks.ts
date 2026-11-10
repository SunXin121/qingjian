// Keyboard deletion around "preview blocks": code blocks that the document shows as a
// rendered preview (text diagrams, drawings, table embeds, formulas).
//
// ProseMirror treats them as ordinary code blocks, so Backspace at the start of the next
// paragraph would merge that paragraph's text into the hidden source, and a selected block
// handed the keys to its (hidden) CodeMirror. Instead, like other block editors:
//   - Backspace / Delete next to such a block first selects it as a whole,
//   - Backspace / Delete on a selected block removes exactly that block.

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { isDrawingKind, textDiagramLang } from './previews'

export function isPreviewBlock(node: PMNode | null | undefined): node is PMNode {
  if (!node || node.type.name !== 'code_block') return false
  const lang = String(node.attrs.language ?? '').toLowerCase()
  return !!textDiagramLang(lang) || isDrawingKind(lang) || lang === 'table' || lang === 'latex'
}

/** A textblock the caret can sit in without opening a code editor. */
const isPlainTextblock = (n: PMNode | null | undefined) => !!n && n.isTextblock && n.type.name !== 'code_block'

/**
 * Delete the block at `pos` and leave the caret in a neighbouring paragraph (the one before
 * it when `preferBefore`), adding an empty paragraph when both neighbours are other blocks.
 */
export function deleteBlockAt(tr: Transaction, pos: number, node: PMNode, preferBefore: boolean): Transaction {
  tr.delete(pos, pos + node.nodeSize)
  const $pos = tr.doc.resolve(pos)
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  if (isPlainTextblock(before) && (preferBefore || !isPlainTextblock(after))) {
    return tr.setSelection(TextSelection.create(tr.doc, pos - 1))
  }
  if (isPlainTextblock(after)) return tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  const paragraph = tr.doc.type.schema.nodes.paragraph
  if ($pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraph)) {
    tr.insert(pos, paragraph.create())
    return tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  }
  return tr.setSelection(TextSelection.near($pos, preferBefore ? -1 : 1))
}

export const previewBlockKeys = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if ((event.key !== 'Backspace' && event.key !== 'Delete') || event.isComposing) return false
          const back = event.key === 'Backspace'
          const { state } = view
          const sel = state.selection

          if (sel instanceof NodeSelection) {
            if (!isPreviewBlock(sel.node)) return false
            view.dispatch(deleteBlockAt(state.tr, sel.from, sel.node, back).scrollIntoView())
            return true
          }

          if (!sel.empty) return false
          const $c = sel.$from
          if (!$c.parent.isTextblock || $c.parent.type.name === 'code_block') return false
          if (back ? $c.parentOffset !== 0 : $c.parentOffset !== $c.parent.content.size) return false
          const edge = back ? $c.before() : $c.after()
          const $edge = state.doc.resolve(edge)
          const target = back ? $edge.nodeBefore : $edge.nodeAfter
          if (!isPreviewBlock(target)) return false

          let targetPos = back ? edge - target.nodeSize : edge
          const tr = state.tr
          // an empty paragraph next to the block just goes away
          if ($c.parent.type.name === 'paragraph' && $c.parent.content.size === 0) {
            tr.delete($c.before(), $c.after())
            if (!back) targetPos -= $c.parent.nodeSize
          }
          view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, targetPos)).scrollIntoView())
          return true
        },
      },
    }),
)
