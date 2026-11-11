// Code block colours: GitHub's light and dark palettes. Plain code is near-black (light) or
// near-white (dark) rather than the theme's muted grey, and comments stay readable.
// Backgrounds come from the page CSS (--c-code-bg), so only text colours are set here.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

interface Palette {
  text: string
  keyword: string
  string: string
  constant: string
  func: string
  type: string
  comment: string
  tag: string
  invalid: string
  selection: string
}

const LIGHT: Palette = {
  text: '#1f2328',
  keyword: '#cf222e',
  string: '#0a3069',
  constant: '#0550ae',
  func: '#8250df',
  type: '#953800',
  comment: '#57606a',
  tag: '#116329',
  invalid: '#82071e',
  selection: '#b6d7ff',
}

const DARK: Palette = {
  text: '#e6edf3',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  constant: '#79c0ff',
  func: '#d2a8ff',
  type: '#ffa657',
  comment: '#8b949e',
  tag: '#7ee787',
  invalid: '#ffa198',
  selection: '#264f78',
}

function build(p: Palette, dark: boolean) {
  const view = EditorView.theme(
    {
      '&': { color: p.text },
      '.cm-content': { caretColor: p.text },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.text },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: p.selection },
      '.cm-matchingBracket': { outline: `1px solid ${p.comment}`, backgroundColor: 'transparent' },
    },
    { dark },
  )
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: p.keyword },
    { tag: [t.processingInstruction, t.meta], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.character, t.docString], color: p.string },
    { tag: [t.regexp, t.escape], color: p.tag },
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name), t.unit], color: p.constant },
    { tag: [t.propertyName, t.attributeName, t.labelName], color: p.constant },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: p.func },
    { tag: [t.typeName, t.className, t.namespace, t.self], color: p.type },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: p.text },
    { tag: [t.variableName, t.name, t.operator, t.punctuation, t.bracket, t.separator], color: p.text },
    { tag: [t.tagName, t.angleBracket], color: p.tag },
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.comment, fontStyle: 'italic' },
    { tag: t.heading, color: p.constant, fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: p.string, textDecoration: 'underline' },
    { tag: [t.inserted], color: p.tag },
    { tag: [t.deleted, t.invalid], color: p.invalid },
  ])
  return [view, syntaxHighlighting(highlight)]
}

export const codeThemeLight = build(LIGHT, false)
export const codeThemeDark = build(DARK, true)
