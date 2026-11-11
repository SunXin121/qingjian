// Milkdown's image block keeps its display height ratio in the markdown alt text and writes
// it as `![1.00](url)`. On read it takes *any* numeric alt as that ratio, so notes from other
// tools whose images are named after a timestamp (`![1555484318133](images/1555484318133.png)`)
// render billions of times their height: a page-long blank box with `object-fit: cover`
// showing only a corner of the picture.
//
// This runs on the parsed markdown and keeps an alt only when it looks like a ratio Milkdown
// wrote itself (a decimal within a sane range); any other alt becomes the default ratio of 1.

import { $remark } from '@milkdown/kit/utils'

interface MdNode {
  type: string
  alt?: string | null
  children?: MdNode[]
}

const MAX_RATIO = 10

export function isImageRatio(alt: string | null | undefined): boolean {
  if (!alt || !/^\d+\.\d+$/.test(alt)) return false
  const v = Number(alt)
  return v > 0 && v <= MAX_RATIO
}

/** Clears numeric alts that are not image-block ratios. Exported for tests. */
export function fixImageRatios(node: MdNode) {
  if (node.type === 'image' || node.type === 'image-block') {
    // non-numeric alts already fall back to 1; only numbers are mistaken for a ratio
    if (node.alt && Number.isFinite(Number(node.alt)) && !isImageRatio(node.alt)) node.alt = ''
  }
  node.children?.forEach(fixImageRatios)
}

export const imageRatioRemark = $remark('qj-image-ratio', () => () => (tree) => fixImageRatios(tree as MdNode))
