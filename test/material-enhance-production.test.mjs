import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const python = process.env.DSH_PROFESSOR_ENHANCE_PYTHON
const backendArgs = ['--backend', process.env.DSH_PROFESSOR_ENHANCE_BACKEND ?? 'docling', ...(process.env.DSH_PROFESSOR_ENHANCE_ARTIFACTS ? ['--artifacts', process.env.DSH_PROFESSOR_ENHANCE_ARTIFACTS] : [])]
test('real enhancement recovers scanned text and borderless table cells without changing sources', { skip: !python && 'no prepared enhancement runtime configured' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-enhance-production-'))
  try {
    execFileSync(python, ['test/helpers/material-enhance-fixtures.py', '--out', temp], { stdio: 'pipe' })
    for (const [file, expected] of [['scanned.pdf', 'OCR'], ['table_html.pdf', 'mass']]) {
      const source = path.join(temp, file)
      const before = await fs.readFile(source)
      const result = JSON.parse(execFileSync(python, ['src/extract/scripts/enhance_pdf.py', '--path', source, '--pages', '1', ...backendArgs], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 }))
      assert.equal(result.ok, true, result.detail)
      assert.ok(result.pages[0].text.includes(expected))
      if (file === 'scanned.pdf') assert.equal(result.pages[0].ocr_completed, true)
      else assert.deepEqual(result.pages[0].blocks.find(b => b.kind === 'table').cells,
        [['Name','Value','Unit'], ['mass','3','kg'], ['speed','9.8','m/s'], ['energy','12.5','J']])
      assert.deepEqual(await fs.readFile(source), before)
    }
    const combined = path.join(temp, 'mixed.pdf')
    execFileSync(python, ['-c', 'import pymupdf,sys; d=pymupdf.open(); a=pymupdf.open(sys.argv[1]); b=pymupdf.open(sys.argv[2]); d.insert_pdf(a); d.insert_pdf(b); d.save(sys.argv[3])', path.join(temp, 'table_html.pdf'), path.join(temp, 'scanned.pdf'), combined])
    const selected = JSON.parse(execFileSync(python, ['src/extract/scripts/enhance_pdf.py', '--path', combined, '--pages', '2', ...backendArgs], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 }))
    assert.equal(selected.ok, true, selected.detail)
    assert.deepEqual(selected.pages.map(p => p.page), [2])
    assert.ok(selected.pages[0].text.includes('扫描件'))
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
