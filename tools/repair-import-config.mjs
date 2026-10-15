import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseYamlLite, dumpYamlLite } from '../src/project/yaml-lite.js'
import { validateProject } from '../src/project/project.js'
import { importPersonalAgentRegistry } from '../src/migrations/personal-agent-registry.js'
import { repairImportedProject } from '../src/migrations/repair-import.js'
import { resolveArtifactRoot } from '../src/artifacts/paths.js'

const args = process.argv.slice(2)
const projectRoot = args[args.indexOf('--project') + 1]
const registryDir = args[args.indexOf('--registry') + 1]
if (!args.includes('--project') || !args.includes('--registry') || !path.isAbsolute(projectRoot) || !path.isAbsolute(registryDir)) throw new Error('Specify absolute --project and --registry paths')
const target = path.join(projectRoot, '.professor/project.yaml')
const original = await fs.readFile(target, 'utf8')
const document = parseYamlLite(original)
if (!validateProject(document).ok) throw new Error('Invalid project; refusing repair')
const { entries, report } = await importPersonalAgentRegistry({ registryDir, only: document.courses.map(course => course.course_code), readText: file => fs.readFile(file, 'utf8'), listDir: dir => fs.readdir(dir) })
if (entries.length !== document.courses.length || report.skipped.length) throw new Error('Incomplete registry; refusing repair')
for (const entry of entries) {
  for (const source of entry.input.sources ?? []) {
    const exams = path.join(source.path, '05_Exams')
    if ((await fs.stat(exams).catch(() => null))?.isDirectory()) source.category_rules = { ...source.category_rules, exams: [exams] }
  }
}
const repaired = repairImportedProject(document, entries)
if (!validateProject(repaired).ok) throw new Error('Repair validation failed')
for (const course of repaired.courses) resolveArtifactRoot({ document: repaired, projectRoot, kind: 'note', course })
const content = dumpYamlLite(repaired)
if (JSON.stringify(parseYamlLite(content)) !== JSON.stringify(repaired)) throw new Error('YAML roundtrip failed')
console.log(JSON.stringify({ target, courses: repaired.courses.map(course => ({ code: course.course_code, outputs: course.outputs, notes: course.notes })), warnings: report.warnings, learning_state_changed: false }, null, 2))
if (args.includes('--apply') && content !== original) {
  if (await fs.readFile(target, 'utf8') !== original) throw new Error('Config changed concurrently; refusing overwrite')
  const backup = `${target}.before-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  await fs.copyFile(target, backup, constants.COPYFILE_EXCL)
  const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n${original.trimEnd().split('\n').map(line => `-${line}`).join('\n')}\n${content.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch\n`
  const result = spawnSync('apply_patch', [], { input: patch, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'apply_patch failed')
  if (await fs.readFile(target, 'utf8') !== content) throw new Error('Post-write verification failed')
  console.log(`Repaired; backup: ${backup}`)
} else console.log(args.includes('--apply') ? 'No changes needed' : 'Dry run; no files modified')
