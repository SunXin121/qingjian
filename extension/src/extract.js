import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { parseClipDraft } from '../../web/src/clipper.ts'

function httpURL(value, base) {
  try {
    const url = new URL(value, base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function cleanContent(root, base) {
  root.querySelectorAll('script,style,noscript,iframe,object,embed,form,input,button,select,textarea,svg,canvas,[hidden],[aria-hidden="true"]').forEach((node) => node.remove())
  for (const node of root.querySelectorAll('a')) {
    const href = httpURL(node.getAttribute('href') || '', base)
    if (href) node.setAttribute('href', href)
    else node.removeAttribute('href')
  }
  for (const node of root.querySelectorAll('img')) {
    const candidates = [node.getAttribute('data-src'), node.getAttribute('data-original'), node.getAttribute('data-lazy-src'), node.getAttribute('src')]
    const src = candidates.filter(Boolean).map((value) => httpURL(value, base)).find(Boolean)
    if (!src) { node.remove(); continue }
    node.setAttribute('src', src)
    node.removeAttribute('srcset')
  }
  // Turndown receives a DOM node, so entity text stays text and cannot become HTML.
  for (const node of root.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (!['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'start', 'checked', 'type'].includes(attr.name)) node.removeAttribute(attr.name)
    }
  }
  return root
}

export function extractPage(doc, mode, selection = doc.defaultView?.getSelection()) {
  const url = doc.location.href
  let title = doc.title || new URL(url).hostname
  let markdown = ''
  if (mode !== 'link') {
    let content
    if (mode === 'selection') {
      if (!selection || selection.isCollapsed || !selection.rangeCount) throw new Error('请先在网页上选中要剪藏的内容')
      content = doc.createElement('div')
      for (let i = 0; i < selection.rangeCount; i++) content.append(selection.getRangeAt(i).cloneContents())
    } else {
      const clone = doc.cloneNode(true)
      // Normalise lazy images before Readability removes site-specific attributes.
      cleanContent(clone, doc.baseURI)
      if (mode === 'article') {
        const article = new Readability(clone, { charThreshold: 80, maxElemsToParse: 60000 }).parse()
        if (!article?.content || !article.textContent?.trim()) throw new Error('未识别到正文，请尝试整页或选中内容模式')
        title = article.title || title
        content = doc.createElement('div')
        // Detached, never inserted into the live page.
        content.innerHTML = article.content
      } else if (mode === 'page') content = clone.body
      else throw new Error('不支持的剪藏方式')
    }
    const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
    service.use(gfm)
    // Literal HTML-looking text must stay literal when later rendered as Markdown.
    const escape = service.escape.bind(service)
    service.escape = (text) => escape(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    service.addRule('safeFencedCode', {
      filter: (node) => node.nodeName === 'PRE',
      replacement: (_content, node) => {
        const text = node.textContent || ''
        const runs = text.match(/`+/g) || []
        const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
        const language = node.querySelector('code')?.className.match(/(?:language-|lang-)([\w+-]+)/)?.[1] || ''
        return `\n\n${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}\n\n`
      },
    })
    markdown = service.turndown(cleanContent(content, doc.baseURI))
  }
  return parseClipDraft({ version: 1, title, url, markdown, mode, capturedAt: new Date().toISOString() })
}
