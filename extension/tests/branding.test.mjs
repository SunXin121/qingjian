import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { brandMessages } from '../scripts/branding.mjs'

test('branding keeps all i18n identifiers and placeholders valid in every locale', async () => {
  for (const locale of ['en', 'zh_CN', 'ja', 'pl']) {
    const original = JSON.parse(await readFile(new URL(`../vendor/edgeever/apps/extension/public/_locales/${locale}/messages.json`, import.meta.url), 'utf8'))
    const branded = brandMessages(original, locale)
    assert.deepEqual(Object.keys(branded), Object.keys(original))
    assert.ok(Object.keys(branded).every((key) => /^[a-z0-9_]+$/i.test(key)))
    assert.ok(branded.savedToEdgeEver)
    assert.ok(!branded.extensionName.message.includes('EdgeEver'))
    for (const key of Object.keys(original)) assert.deepEqual(branded[key].placeholders, original[key].placeholders)
  }
})
