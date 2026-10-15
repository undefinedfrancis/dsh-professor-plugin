/** Prepare an existing native Professor session and validated native file-reference draft. */
const invalid = message => Object.assign(new Error(message), { code: 'PROFESSOR_MATERIAL_INVALID' })
const changed = () => Object.assign(new Error('Material or native workspace changed during setup; reload and retry'), { code: 'PROFESSOR_MATERIAL_CHANGED' })
const id = value => typeof value === 'string' && value.trim() && value.length <= 128
export function createMaterialLauncher({ validator, home, sessionProjectRoot }) {
  let disposed = false
  const active = new Set()
  return {
    async launch(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
          Reflect.ownKeys(input).some(key => !['requestId', 'courseId', 'fileId', 'mode'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) ||
          !/^[A-Za-z0-9_-]{8,64}$/.test(input.requestId ?? '') || !id(input.courseId) || !id(input.fileId) || !['learn', 'question'].includes(input.mode)) throw invalid('Choose a material, course and supported study mode')
      const request = { ...input }
      const controller = new AbortController()
      if (disposed) controller.abort()
      active.add(controller)
      try {
        controller.signal.throwIfAborted()
        const before = await validator.validate({ courseId: request.courseId, fileId: request.fileId }, { signal: controller.signal })
        if (typeof before.relativePath !== 'string' || /[\u0000-\u001f\u007f-\u009f"]/u.test(before.relativePath)) throw invalid('This material name cannot be represented by a native file reference')
        controller.signal.throwIfAborted()
        const native = await home.launch({ requestId: request.requestId, courseId: request.courseId, mode: request.mode, topic: 'Material ' + request.fileId, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!id(native.sessionId) || await sessionProjectRoot(native.sessionId) !== before.projectRoot) throw changed()
        const after = await validator.validate({ courseId: request.courseId, fileId: request.fileId }, { signal: controller.signal })
        if (after.projectRoot !== before.projectRoot || after.relativePath !== before.relativePath || after.contentHash !== before.contentHash || after.observedVersion !== before.observedVersion) throw changed()
        controller.signal.throwIfAborted()
        return { sessionId: native.sessionId, fileId: request.fileId, relativePath: after.relativePath, contentHash: after.contentHash, readyForDraft: true }
      } finally { active.delete(controller) }
    },
    dispose() { disposed = true; for (const controller of active) controller.abort(); active.clear() },
  }
}
