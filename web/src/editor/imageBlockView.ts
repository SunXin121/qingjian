// Crepe's image block gives its picture a height only once it has loaded (natural size
// fitted to the column, times the ratio kept in the markdown), so every image starts as a
// 100px box and the page below it jumps when it arrives, even when it comes from the cache.
// This wraps the stock view: images whose natural size is remembered from an earlier visit
// (sizeMemo.ts) get that same height before the first paint.

import { imageBlockSchema } from '@milkdown/kit/component/image-block'
import { nodeViewCtx, SchemaReady } from '@milkdown/kit/core'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import { $viewAsync } from '@milkdown/kit/utils'
import { imageSize, rememberImageSize } from './sizeMemo'

const toSize = new Map<HTMLElement, number>() // block -> ratio
let queued = false

function sizeFromMemory() {
  queued = false
  const due: { img: HTMLImageElement; height: number }[] = []
  // measure all first (one layout), then write
  for (const [dom, ratio] of toSize) {
    if (!dom.isConnected) continue
    const img = dom.querySelector<HTMLImageElement>('.image-wrapper img')
    const size = img && !img.dataset.height ? imageSize(img.getAttribute('src') ?? '') : undefined
    const maxWidth = dom.getBoundingClientRect().width
    if (!img || !size || !maxWidth) continue
    // the stock view's onImageLoad, which sets the same height again once the image loads
    const [w, h] = size
    const fitted = w < maxWidth ? h : maxWidth * (h / w)
    due.push({ img, height: fitted * (ratio || 1) })
    img.dataset.origin = fitted.toFixed(2)
  }
  toSize.clear()
  for (const { img, height } of due) {
    img.dataset.height = height.toFixed(2)
    img.style.height = `${height.toFixed(2)}px`
  }
}

export const imageSizeView = $viewAsync(imageBlockSchema.node, async (ctx) => {
  await ctx.wait(SchemaReady)
  // let Crepe's image block view (registered synchronously after SchemaReady) land first
  await new Promise((r) => setTimeout(r))
  const stock = ctx.get(nodeViewCtx).find(([id]) => id === imageBlockSchema.node.id)?.[1]
  if (!stock) {
    console.warn('imageSizeView: stock image block view not found; images show without their controls')
    return ((node) => {
      const img = document.createElement('img')
      img.src = node.attrs.src
      img.alt = node.attrs.caption ?? ''
      return { dom: img }
    }) as NodeViewConstructor
  }
  const factory: NodeViewConstructor = (node, view, getPos, decorations, innerDecorations) => {
    const nv = stock(node, view, getPos, decorations, innerDecorations)
    const dom = nv.dom as HTMLElement
    // `load` does not bubble, but it can be caught on the way down
    dom.addEventListener('load', (e) => e.target instanceof HTMLImageElement && rememberImageSize(e.target), true)
    toSize.set(dom, Number(node.attrs.ratio) || 1)
    // a microtask: by then ProseMirror has put the block's DOM in the page
    if (!queued) {
      queued = true
      queueMicrotask(sizeFromMemory)
    }
    return nv
  }
  return factory
})
