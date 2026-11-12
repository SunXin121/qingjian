import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractPage } from '../src/extract.js'

const page = (body) => new JSDOM(`<!doctype html><html><head><title>测试文章</title></head><body>${body}</body></html>`, { url: 'https://example.com/posts/one' })

test('正文提取保留标题、段落，且不修改原始页面', () => {
  const dom = page(`<nav>导航</nav><article><h1>测试文章</h1>${'<p>这是有足够内容的中文文章，用来验证正文提取。正文包含事实、说明以及可以长期保存的知识。</p>'.repeat(12)}</article><footer>页脚</footer>`)
  const before = dom.window.document.documentElement.outerHTML
  const draft = extractPage(dom.window.document, 'article')
  assert.equal(draft.title, '测试文章')
  assert.match(draft.markdown, /这是有足够内容/)
  assert.doesNotMatch(draft.markdown, /导航|页脚/)
  assert.equal(dom.window.document.documentElement.outerHTML, before)
  dom.window.close()
})

test('整页转换相对链接、懒加载图片、表格和围栏内的反引号', () => {
  const dom = page('<h2>标题</h2><a href="../next">下一篇</a><img src="data:image/gif;base64,R0" data-src="/images/photo.jpg" alt="照片"><table><thead><tr><th>名称</th><th>数值</th></tr></thead><tbody><tr><td>甲</td><td>1</td></tr></tbody></table><pre><code class="language-js">const fence = "```";</code></pre>')
  const draft = extractPage(dom.window.document, 'page')
  assert.match(draft.markdown, /## 标题/)
  assert.match(draft.markdown, /https:\/\/example.com\/next/)
  assert.match(draft.markdown, /!\[照片\]\(https:\/\/example.com\/images\/photo.jpg\)/)
  assert.match(draft.markdown, /\| 名称 \| 数值 \|/)
  assert.match(draft.markdown, /````js\nconst fence = "```";\n````/)
  dom.window.close()
})

test('选区只保留选中内容及其格式', () => {
  const dom = page('<p>不应剪藏</p><div id="selection"><strong>重要内容</strong><a href="/reference">参考</a></div>')
  const selection = dom.window.getSelection()
  const range = dom.window.document.createRange()
  range.selectNodeContents(dom.window.document.querySelector('#selection'))
  selection.addRange(range)
  const draft = extractPage(dom.window.document, 'selection')
  assert.match(draft.markdown, /\*\*重要内容\*\*/)
  assert.match(draft.markdown, /https:\/\/example.com\/reference/)
  assert.doesNotMatch(draft.markdown, /不应剪藏/)
  dom.window.close()
})

test('仅链接允许空正文；无选区或空白页提示切换方式', () => {
  const dom = page('')
  assert.equal(extractPage(dom.window.document, 'link').markdown, '')
  assert.throws(() => extractPage(dom.window.document, 'selection'), /先在网页上选中/)
  assert.throws(() => extractPage(dom.window.document, 'page'), /没有提取到内容/)
  assert.throws(() => extractPage(dom.window.document, 'article'), /未识别到正文/)
  dom.window.close()
})

test('移除脚本、表单、危险 URL，HTML 示例保持为文本', () => {
  const dom = page('<script>alert(1)</script><iframe src="https://tracker.test"></iframe><form>不应保存<input value="private"></form><p>&lt;img src=x onerror=alert(1)&gt;</p><a href="javascript:alert(1)">危险链接</a><img src="javascript:alert(1)"><p>正常内容</p>')
  const draft = extractPage(dom.window.document, 'page')
  assert.doesNotMatch(draft.markdown, /javascript:|<script|<iframe|不应保存|private/)
  assert.match(draft.markdown, /&lt;img/)
  assert.match(draft.markdown, /正常内容/)
  dom.window.close()
})
