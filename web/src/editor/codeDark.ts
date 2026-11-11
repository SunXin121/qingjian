// Code block colours for the dark theme. In the light theme code blocks keep CodeMirror's
// default highlighting; that palette is made for light backgrounds (#00f, #00c, #30a…), so
// in the dark the same groups get the same hues, lifted until they read on a dark block.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const style = HighlightStyle.define([
  { tag: t.meta, color: '#9aa39b' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.keyword, color: '#d29bf5' },
  { tag: [t.atom, t.bool, t.url, t.contentSeparator, t.labelName], color: '#8fa2ff' },
  { tag: [t.literal, t.inserted], color: '#7fd1a0' },
  { tag: [t.string, t.deleted], color: '#ff8f85' },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: '#ffab70' },
  { tag: t.definition(t.variableName), color: '#7cb4ff' },
  { tag: t.local(t.variableName), color: '#b8a2ff' },
  { tag: [t.typeName, t.namespace], color: '#5fd4a8' },
  { tag: t.className, color: '#6cd0d0' },
  { tag: [t.special(t.variableName), t.macroName], color: '#7fc8dc' },
  { tag: t.definition(t.propertyName), color: '#84b6ff' },
  { tag: t.comment, color: '#c8a27a' },
  { tag: t.invalid, color: '#ff6b6b' },
])

/** Highlighting for code blocks in the dark theme (replaces CodeMirror's light default). */
export const codeHighlightDark = syntaxHighlighting(style)
