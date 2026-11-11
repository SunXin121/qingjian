// Progressive loading of long documents: the editor is created with the first part of the
// markdown only, so the top of the page shows up at once, and the rest is parsed and
// appended in small pieces afterwards (see Editor.tsx).
//
// This file holds the splitting. Every piece must parse to exactly the top-level blocks the
// whole document would give there, so it only cuts in front of a line that always starts a
// new top-level block: a heading, or text at column 0 after a blank line (which ends any
// list, quote, table or paragraph before it). Fenced code, math and raw HTML that can span
// blank lines are never cut, and documents with reference-style links or footnotes (whose
// definitions apply across the whole text) are not split at all.

/** documents shorter than this are loaded in one go */
export const PROGRESSIVE_MIN = 40_000
/** size of the part the editor is created with */
export const HEAD_SIZE = 12_000
/** size of each later piece: large enough to finish quickly, small enough to stay below a frame or two */
export const CHUNK_SIZE = 16_000

const REF_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m
const HEADING = /^#{1,6}(?:[ \t]|$)/
// a letter or a CJK character at column 0: a plain paragraph (digits could be an ordered
// list, punctuation a list, quote, table, html or link)
const TEXT_START = /^[\p{L}\p{Script=Han}]/u
const FENCE = /^ *(`{3,}|~{3,})/
const HTML_RAW_OPEN = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i

/**
 * Split markdown into pieces of roughly `head` and then `chunk` characters, at line starts
 * where a top-level block begins. Joining the pieces gives back the input exactly. Returns a
 * single piece when the document cannot be split safely.
 */
export function splitMarkdown(md: string, head = HEAD_SIZE, chunk = CHUNK_SIZE): string[] {
  if (REF_DEFINITION.test(md)) return [md]
  const out: string[] = []
  let start = 0 // start of the current piece
  let target = head
  let fence: string | null = null // the opening fence while inside fenced code
  let math = false
  let comment = false
  let raw: string | null = null // closing tag while inside <pre>, <script>, …
  let prevBlank = false
  let pos = 0
  while (pos < md.length) {
    let end = md.indexOf('\n', pos)
    if (end < 0) end = md.length
    const line = md.slice(pos, end)
    const inside = fence !== null || math || comment || raw !== null
    if (!inside && pos > start && pos - start >= target && (HEADING.test(line) || (prevBlank && TEXT_START.test(line)))) {
      out.push(md.slice(start, pos))
      start = pos
      target = chunk
    }
    // track the constructs that may contain blank lines
    if (fence !== null) {
      const m = FENCE.exec(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.slice(m[0].length).trim() === '') fence = null
    } else if (math) {
      if (line.trim() === '$$') math = false
    } else if (comment) {
      if (line.includes('-->')) comment = false
    } else if (raw !== null) {
      if (line.toLowerCase().includes(raw)) raw = null
    } else {
      const f = FENCE.exec(line)
      const r = HTML_RAW_OPEN.exec(line)
      const t = line.trim()
      if (f) fence = f[1]
      // `$$` opens a math block unless the formula closes on the same line
      else if (t.startsWith('$$')) math = t.length < 4 || !t.endsWith('$$')
      else if (/^ {0,3}<!--/.test(line)) comment = !line.includes('-->', line.indexOf('<!--') + 4)
      else if (r) raw = line.toLowerCase().includes(`</${r[1].toLowerCase()}>`) ? null : `</${r[1].toLowerCase()}>`
    }
    prevBlank = line.trim() === ''
    pos = end + 1
  }
  out.push(md.slice(start))
  return out
}
