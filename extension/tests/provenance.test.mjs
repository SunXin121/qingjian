import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../vendor/edgeever/', import.meta.url)
test('all imported upstream files remain identical to the pinned revision', async () => {
  const provenance = JSON.parse(await readFile(new URL('UPSTREAM.json', root), 'utf8'))
  assert.equal(provenance.commit, '8fc9851c0b6a8e764b74a835237b2920c3b5120f')
  for (const [path, expected] of Object.entries(provenance.files)) {
    const content = await readFile(join(fileURLToPath(root), path))
    assert.equal(createHash('sha256').update(content).digest('hex'), expected, `Upstream file changed: ${path}`)
  }
})
