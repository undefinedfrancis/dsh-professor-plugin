/** Narrow Settings actions dispatched through an owned native Professor session's tool pipeline. */
import { randomUUID } from 'node:crypto'

const fail = (code, message) => Object.assign(new Error(message), { code: `PROFESSOR_COMMAND_${code}` })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
function fields(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw fail('INVALID', 'Unexpected command fields')
  }
}
const TOOLS = Object.freeze({ discover: 'professor_workspace_discover', confirm: 'professor_workspace_confirm',
  rebuild: 'professor_workspace_rebuild', diagnostics: 'professor_diagnostics',
  courses: 'professor_course_list', manageCourse: 'professor_course_manage' })

export function createProfessorCommands({ registry, resolveAgent, composedPreset, readConnectionRevision, execute, now = Date.now }) {
  const proposals = new Map()
  const courseSnapshots = new Map()
  let tail = Promise.resolve()
  let disposed = false
  let active = null

  function validate(input) {
    fields(input, ['sessionId', 'action', 'args'])
    if (!text(input.sessionId) || !Object.hasOwn(TOOLS, input.action)) throw fail('INVALID', 'Choose a supported action and native session')
    const args = input.args ?? {}
    fields(args, input.action === 'discover' ? ['folder'] : input.action === 'confirm' ? ['proposalToken', 'selections', 'acknowledgeFolderChange'] : input.action === 'manageCourse' ? ['courseToken', 'courseId', 'operation', 'displayName', 'term', 'courseCode', 'confirmDelete'] : [])
    if (input.action === 'manageCourse') {
      if (!text(args.courseToken) || !text(args.courseId, 240) || !['update', 'archive', 'reactivate', 'delete'].includes(args.operation)) throw fail('INVALID', 'Choose an observed course and supported operation')
      for (const key of ['displayName', 'term']) if (args[key] !== undefined && !text(args[key], 240)) throw fail('INVALID', 'Invalid course identity')
      // The visible course code is editable, with the documented bounds: trimmed by the registry,
      // non-empty, at most 240 characters, no control characters.
      if (args.courseCode !== undefined && (!text(args.courseCode, 240) || /[\x00-\x1f\x7f]/u.test(args.courseCode))) throw fail('INVALID', 'Invalid course code')
      if (args.operation === 'delete') {
        // The one irreversible course operation: it must be asked for explicitly, and it can never
        // smuggle an edit along with it.
        if (args.confirmDelete !== true) throw fail('INVALID', 'Deleting a course needs an explicit confirmation')
        if (args.displayName !== undefined || args.term !== undefined || args.courseCode !== undefined) throw fail('INVALID', 'A deletion cannot also edit course fields')
      } else {
        if (args.confirmDelete !== undefined) throw fail('INVALID', 'Only a deletion carries a confirmation')
        if (args.operation !== 'update' && (args.displayName !== undefined || args.term !== undefined || args.courseCode !== undefined)) throw fail('INVALID', 'Status changes cannot edit course fields')
        if (args.operation === 'update' && args.displayName === undefined && args.term === undefined && args.courseCode === undefined) throw fail('INVALID', 'Choose a field to update')
      }
    }
    if (input.action === 'discover' && args.folder !== undefined && !text(args.folder, 4096)) throw fail('INVALID', 'Invalid folder')
    if (input.action === 'confirm') {
      if (!text(args.proposalToken) || !Array.isArray(args.selections) || args.selections.length > 200 ||
        (args.acknowledgeFolderChange !== undefined && typeof args.acknowledgeFolderChange !== 'boolean')) throw fail('INVALID', 'Confirm a current proposal with explicit selections')
      const paths = new Set()
      for (const row of args.selections) {
        fields(row, ['relative_path', 'action', 'course_code', 'display_name', 'term'])
        if (!text(row.relative_path, 4096) || paths.has(row.relative_path) || !['include', 'exclude'].includes(row.action)) throw fail('INVALID', 'Invalid or duplicate course selection')
        paths.add(row.relative_path)
        for (const key of ['course_code', 'display_name', 'term']) if (row[key] !== undefined && !text(row[key], 240)) throw fail('INVALID', 'Invalid course identity')
      }
    }
    if (JSON.stringify(input).length > 65536) throw fail('INVALID', 'Command exceeds its size budget')
    return structuredClone({ sessionId: input.sessionId, action: input.action, args })
  }

  async function dispatch(input) {
    if (disposed) throw fail('UNAVAILABLE', 'Settings commands have been withdrawn')
    for (const [key, entry] of proposals) if (now() - entry.createdAt > 15 * 60 * 1000) proposals.delete(key)
    for (const [key, entry] of courseSnapshots) if (now() - entry.createdAt > 15 * 60 * 1000) courseSnapshots.delete(key)
    const row = await registry.get(input.sessionId)
    if (row?.status !== 'ready') throw fail('SESSION', 'Select a ready Professor-owned session')
    const agent = await resolveAgent(input.sessionId)
    if (agent?.session?.id !== input.sessionId || await composedPreset(agent) !== 'professor') throw fail('SESSION', 'This session no longer uses Professor')
    let args = input.args, entry
    if (input.action === 'courses') args = { include_archived: true }
    if (input.action === 'manageCourse') {
      const snapshot = courseSnapshots.get(args.courseToken)
      if (!snapshot || snapshot.sessionId !== input.sessionId || await readConnectionRevision() !== snapshot.revision) throw fail('PROPOSAL', 'Reload courses in the same Professor session before editing')
      if (!snapshot.courseIds.includes(args.courseId)) throw fail('INVALID', 'Course was not part of this snapshot')
      args = { action: args.operation, course_id: args.courseId, expected_config_digest: snapshot.digest, expected_project_root: snapshot.root,
        ...(args.operation === 'delete' ? { confirm_delete: true } : {}),
        ...(args.displayName === undefined ? {} : { display_name: args.displayName }), ...(args.term === undefined ? {} : { term: args.term }),
        ...(args.courseCode === undefined ? {} : { course_code: args.courseCode }) }
    }
    if (input.action === 'confirm') {
      entry = proposals.get(args.proposalToken)
      if (!entry || entry.sessionId !== input.sessionId) throw fail('PROPOSAL', 'Discover this folder again in the same Professor session')
      const candidates = new Set(entry.proposal.candidates.map(row => row.relative_path))
      if (args.selections.some(row => !candidates.has(row.relative_path))) throw fail('INVALID', 'Selection is not part of this proposal')
      if (await readConnectionRevision() !== entry.revision) throw fail('PROPOSAL', 'The connection changed; discover and confirm again')
      args = { proposal: structuredClone(entry.proposal), selections: args.selections,
        acknowledge_folder_change: args.acknowledgeFolderChange === true,
        expected_revision: entry.revision }
    }
    const callId = `professor-settings-${randomUUID()}`
    const revision = ['discover', 'courses'].includes(input.action) ? await readConnectionRevision() : undefined
    if (disposed) throw fail('UNAVAILABLE', 'Settings commands have been withdrawn')
    const controller = new AbortController()
    active = controller
    let result
    try {
      result = await execute({ name: TOOLS[input.action], arguments: args, agent,
        signal: controller.signal, callId, rootCallId: callId, turnId: callId })
    } finally { if (active === controller) active = null }
    const body = (result?.content ?? []).filter(part => part.type === undefined || part.type === 'text').map(part => part.text ?? '').join('\n')
    if (result?.isError || body.length > 60000) throw fail('TOOL', 'The native tool refused or exceeded the Settings result budget')
    let payload
    try { payload = JSON.parse(body) } catch { throw fail('TOOL', 'Native tool returned unreadable data') }
    if (!plain(payload)) throw fail('TOOL', 'Native tool returned invalid data')
    if (disposed) throw fail('UNAVAILABLE', 'Settings commands have been withdrawn')
    if (input.action === 'discover' && payload.ok === true && payload.proposal) {
      if (!Array.isArray(payload.proposal.candidates)) throw fail('TOOL', 'Native proposal is invalid')
      const token = randomUUID()
      if (!Number.isSafeInteger(revision) || revision < 0) throw fail('TOOL', 'Connection revision is unavailable')
      if (proposals.size >= 20) proposals.delete(proposals.keys().next().value)
      proposals.set(token, { sessionId: input.sessionId, proposal: structuredClone(payload.proposal), revision, createdAt: now() })
      payload.proposalToken = token
    }
    if (input.action === 'confirm' && payload.applied === true) proposals.delete(input.args.proposalToken)
    if (input.action === 'courses' && payload.projectPresent === true) {
      if (!text(payload.projectRoot, 4096) || !/^[a-f0-9]{64}$/.test(payload.configDigest) || !Array.isArray(payload.courses) ||
          payload.courses.some(course => !text(course.course_id, 240)) || !Number.isSafeInteger(revision) || revision < 0) throw fail('TOOL', 'Native course snapshot is invalid')
      const token = randomUUID()
      if (courseSnapshots.size >= 20) courseSnapshots.delete(courseSnapshots.keys().next().value)
      courseSnapshots.set(token, { sessionId: input.sessionId, courseIds: payload.courses.map(course => course.course_id), root: payload.projectRoot, digest: payload.configDigest, revision, createdAt: now() })
      payload.courseToken = token
    }
    if (input.action === 'manageCourse') courseSnapshots.delete(input.args.courseToken)
    return payload
  }

  return {
    run(input) {
      let snapshot
      try { snapshot = validate(input) } catch (error) { return Promise.reject(error) }
      const work = tail.then(() => dispatch(snapshot))
      tail = work.catch(() => {})
      return work
    },
    dispose() { disposed = true; active?.abort(); proposals.clear(); courseSnapshots.clear() },
  }
}
