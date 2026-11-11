// Raw HTML `<img>` tags, as Typora and many blogs write them to scale a picture:
//
//   <img src="https://…/a.png" alt="image-2025…" style="zoom:50%;" />
//
// Milkdown shows raw HTML as literal text. This turns HTML that is nothing but images (plus
// harmless wrappers such as <p align="center"> or <br>) into real image nodes: a standalone
// one becomes an image block, one inside a line of text an inline image. Styling such as
// zoom is dropped; the picture is saved back as plain `![](url)` markdown.

import { $remark } from '@milkdown/kit/utils'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  [key: string]: unknown
}

export interface HtmlImage {
  src: string
  alt: string
  title: string
}

const IMG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
// tags that may wrap the images without carrying content of their own
const WRAPPER = /<\/?(?:p|div|center|span|figure|br)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
const BLOCK_PARENTS = new Set(['root', 'listItem', 'blockquote', 'footnoteDefinition'])

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const safeSrc = (src: string) => !/^\s*(?:javascript|vbscript):/i.test(src)

/** The images in `html` when it consists of nothing else, otherwise null. */
export function parseHtmlImages(html: string): HtmlImage[] | null {
  const images: HtmlImage[] = []
  const rest = html.replace(IMG, (_, attrs: string) => {
    const a: Record<string, string> = {}
    for (const m of attrs.matchAll(ATTR)) a[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '')
    if (a.src && safeSrc(a.src)) images.push({ src: a.src, alt: a.alt ?? '', title: a.title ?? '' })
    return ''
  })
  if (!images.length || rest.replace(WRAPPER, '').trim() !== '') return null
  return images
}

const htmlImages = (n: MdNode) => (n.type === 'html' && typeof n.value === 'string' ? parseHtmlImages(n.value) : null)

function convert(node: MdNode) {
  const kids = node.children
  if (!kids) return
  const block = BLOCK_PARENTS.has(node.type)
  const out: MdNode[] = []
  for (const child of kids) {
    let images = htmlImages(child)
    // Milkdown wraps block-level HTML in a paragraph before this runs: a paragraph holding
    // nothing but image HTML is still a standalone picture
    if (!images && block && child.type === 'paragraph' && child.children?.length) {
      const parts = child.children.filter((c) => !(c.type === 'text' && !String(c.value ?? '').trim()))
      const found = parts.map(htmlImages)
      if (parts.length && found.every(Boolean)) images = found.flatMap((f) => f!)
    }
    if (!images) {
      convert(child)
      out.push(child)
    } else if (block) {
      // image-block keeps its height ratio in alt; the HTML alt is a file name, not a ratio
      for (const img of images) out.push({ type: 'image-block', url: img.src, alt: '', title: '' })
    } else {
      for (const img of images) out.push({ type: 'image', url: img.src, alt: img.alt, title: img.title || null })
    }
  }
  node.children = out
}

/** Exported for tests. */
export function convertHtmlImages(tree: MdNode) {
  convert(tree)
}

export const htmlImagesRemark = $remark('qj-html-images', () => () => (tree) => convertHtmlImages(tree as MdNode))
