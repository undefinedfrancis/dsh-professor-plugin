/**
 * Professor Home — the browser bundle.
 *
 * Hand-written (no bundler, no CDN, no build step) in the one shape the host's client module system
 * consumes: a *registration* that defers every side effect to its factory closure.
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory })
 * ```
 *
 * `factory(require)` materializes once, on first import, and returns the module face — `{ apply,
 * inject }`, exactly like every official client package. Everything the UI needs comes through that
 * single `require` and the Cordis context handed to `apply`:
 *
 *   - `react` — the **host's** React (never a copy, never from a CDN);
 *   - `ctx.remote.professorHome` — the official Typed Remote namespace mounted here from
 *     `client/remote.js` through `ctx.remote.$mount(...)`;
 *   - `ctx.slots` / `ctx.layout` / `ctx.uiWorkspace` — the official slots and navigation used for the
 *     sidebar entry, the keyed main panel, and native-session navigation.
 *
 * Deliberately absent: mastery charts, grades, calendars, study timers, exam countdowns, and any
 * placeholder button for a capability that does not exist. Every control here either does what it
 * says or is not rendered.
 *
 * Keep this file's descriptor table identical to `client/remote.js` — `test/client-bundle.test.mjs`
 * asserts it, because a browser contribution that silently drifted from its ESM twin would be a
 * second, untested copy of the wire contract.
 */
window.__ModuleLoader__.load({
  id: 'dsh-professor-spike',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    // #region constants
    /** Keyed main-panel id. `ctx.layout.selectPanel(PANEL_ID)` reveals Home. */
    var PANEL_ID = 'professor-home'
    /** Sidebar contribution name and order (below the chat entry_point). */
    var SIDEBAR_SLOT = 'sidebar.panellist'
    var REMOTE_PACKAGE = 'dsh-professor-spike'
    var NAMESPACE = 'professorHome'

    /** The six supported study modes, in the order they are offered. */
    var STUDY_MODES = ['learn', 'question', 'assignment', 'review', 'exam', 'free']
    var MODE_LABELS = {
      learn: '学习',
      question: '提问',
      assignment: '作业',
      review: '复习',
      exam: '备考',
      free: '自由学习',
    }
    // #endregion

    // #region the Typed Remote contribution (mirrors client/remote.js)
    function strict(typeSymbol, parse) {
      return { mode: 'strict', typeSymbol: typeSymbol, create: function () { return { parse: parse } } }
    }
    function refuse(detail) {
      throw new TypeError('professorHome client rejected its own payload: ' + detail)
    }
    var LAUNCH_REQUEST = strict(REMOTE_PACKAGE + '#launchRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a launch request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        var key = Object.keys(value)[i]
        if (['requestId', 'mode', 'courseId', 'topic', 'folder'].indexOf(key) === -1) refuse('unexpected launch field "' + key + '"')
      }
      if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId)) refuse('requestId must be 8-64 safe characters')
      if (typeof value.mode !== 'string' || STUDY_MODES.indexOf(value.mode) === -1) refuse('mode must be one of ' + STUDY_MODES.join(', '))
      if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.length === 0 || value.courseId.length > 128)) refuse('courseId must be absent, null or a bounded string')
      if (value.topic != null && (typeof value.topic !== 'string' || value.topic.length > 200)) refuse('the topic must be absent or at most 200 characters')
      if (value.folder !== undefined && (typeof value.folder !== 'string' || value.folder.length === 0 || value.folder.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.folder) || value.mode !== 'free' || value.courseId != null)) refuse('invalid setup folder')
      return value
    })
    var REOPEN_REQUEST = strict(REMOTE_PACKAGE + '#reopenRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a reopen request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (Object.keys(value)[i] !== 'sessionId') refuse('unexpected reopen field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128) refuse('sessionId must be a bounded non-empty string')
      return value
    })
    var CLEAR_REQUEST = strict(REMOTE_PACKAGE + '#clearRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a clear request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (['sessionId', 'confirmed'].indexOf(Object.keys(value)[i]) === -1) refuse('unexpected clear field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0 || value.sessionId.length > 128) refuse('sessionId must be a bounded non-empty string')
      if (value.confirmed !== true) refuse('clearing requires confirmed: true')
      return { sessionId: value.sessionId, confirmed: true }
    })
    var CLEAR_ALL_SNAPSHOT_REQUEST = strict(REMOTE_PACKAGE + '#clearAllSnapshotRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) refuse('a snapshot request takes no fields')
      return {}
    })
    var CLEAR_ALL_START_REQUEST = strict(REMOTE_PACKAGE + '#clearAllStartRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a bulk clear start must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (Object.keys(value)[i] !== 'token') refuse('unexpected bulk field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.token !== 'string' || value.token.trim().length === 0 || value.token.length > 128) refuse('token must be a bounded non-empty string')
      return { token: value.token }
    })
    var CLEAR_ALL_CONTINUE_REQUEST = strict(REMOTE_PACKAGE + '#clearAllContinueRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a bulk clear continuation must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (Object.keys(value)[i] !== 'operationId') refuse('unexpected bulk field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.operationId !== 'string' || value.operationId.trim().length === 0 || value.operationId.length > 128) refuse('operationId must be a bounded non-empty string')
      return { operationId: value.operationId }
    })
    function presetEnvelope(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset definition must be a plain object')
      var allowed = ['id', 'name', 'description', 'fields', 'version', 'provenance']
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (allowed.indexOf(Object.keys(value)[i]) === -1) refuse('unexpected preset field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) refuse('preset id must be lowercase letters, digits and dashes')
      if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 80) refuse('preset name must be at most 80 characters')
      if (typeof value.description !== 'string' || value.description.trim().length === 0 || value.description.length > 240) refuse('preset description must be at most 240 characters')
      if (value.fields === null || typeof value.fields !== 'object' || Array.isArray(value.fields)) refuse('preset fields must be a plain object')
      if (JSON.stringify(value.fields).length > 8192) refuse('preset fields exceed the wire budget')
      if (!Number.isSafeInteger(value.version) || value.version < 1) refuse('preset version must be a positive integer')
      if (value.provenance !== undefined && (typeof value.provenance !== 'string' || value.provenance.length > 240)) refuse('preset provenance must be at most 240 characters')
      return value
    }
    var PRESET_LIBRARY_REQUEST = strict(REMOTE_PACKAGE + '#presetLibraryRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset library request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (['skill', 'courseId'].indexOf(Object.keys(value)[i]) === -1) refuse('unexpected preset field "' + Object.keys(value)[i] + '"')
      }
      if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) refuse('invalid skill selector')
      if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.trim().length === 0 || value.courseId.length > 128)) refuse('invalid course selector')
      return value
    })
    var PRESET_SAVE_REQUEST = strict(REMOTE_PACKAGE + '#presetSaveRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset save request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (['definition', 'expectedRevision'].indexOf(Object.keys(value)[i]) === -1) refuse('unexpected preset field "' + Object.keys(value)[i] + '"')
      }
      if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
      presetEnvelope(value.definition)
      return value
    })
    var PRESET_DELETE_REQUEST = strict(REMOTE_PACKAGE + '#presetDeleteRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset delete request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (['presetId', 'expectedRevision', 'confirmed'].indexOf(Object.keys(value)[i]) === -1) refuse('unexpected preset field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) refuse('invalid preset id')
      if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
      if (value.confirmed !== true) refuse('deleting a preset requires confirmed: true')
      return value
    })
    var PRESET_APPLY_REQUEST = strict(REMOTE_PACKAGE + '#presetApplyRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset apply request must be a plain object')
      for (var i = 0; i < Object.keys(value).length; i++) {
        if (['presetId', 'courseId', 'expectedRevision'].indexOf(Object.keys(value)[i]) === -1) refuse('unexpected preset field "' + Object.keys(value)[i] + '"')
      }
      if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) refuse('invalid preset id')
      if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.trim().length === 0 || value.courseId.length > 128)) refuse('invalid course selector')
      if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
      return value
    })
    /**
     * Result codecs. A contribution is invalid without them: the client registry validates
     * `descriptor.result` before it will mount anything, and its codec is what decodes the reply.
     * The shape of a reply is decided host-side (`src/app/remote.js`); here the invariant that
     * matters is only that it is a bounded plain object, never a container the UI renders raw.
     */
    function result(typeSymbol) {
      return strict(typeSymbol, function (value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('the ' + typeSymbol + ' reply must be a plain object')
        if (JSON.stringify(value).length > 64 * 1024) refuse('the reply exceeds the 64 KiB wire budget')
        return value
      })
    }
    var HOME_RESULT = result(REMOTE_PACKAGE + '#homeResult')
    var LAUNCH_RESULT = result(REMOTE_PACKAGE + '#launchResult')
    var REOPEN_RESULT = result(REMOTE_PACKAGE + '#reopenResult')
    var CLEAR_RESULT = result(REMOTE_PACKAGE + '#clearResult')
    var CLEAR_ALL_RESULT = result(REMOTE_PACKAGE + '#clearAllResult')
    var PRESET_RESULT = result(REMOTE_PACKAGE + '#presetResult')
    var VIEW_REQUEST = strict(REMOTE_PACKAGE + '#viewRequest', function (value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536) refuse('invalid view request')
      Object.keys(value).forEach(function (key) { if (['courseId', 'skill', 'offset', 'fields', 'expectedRevision', 'reset'].indexOf(key) === -1) refuse('unexpected view field') })
      if (value.courseId != null && (typeof value.courseId !== 'string' || !value.courseId.trim() || value.courseId.length > 128)) refuse('invalid course selector')
      if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) refuse('invalid skill selector')
      ;['offset', 'expectedRevision'].forEach(function (key) { if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) refuse('invalid revision or offset') })
      if (value.reset !== undefined && typeof value.reset !== 'boolean') refuse('invalid reset')
      if (value.fields !== undefined && (value.fields === null || typeof value.fields !== 'object' || Array.isArray(value.fields))) refuse('invalid fields')
      return value
    })
    var MATERIAL_REQUEST = strict(REMOTE_PACKAGE + '#materialRequest', function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return ['requestId', 'courseId', 'fileId', 'mode'].indexOf(key) === -1 }) ||
          !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId || '') || !['courseId', 'fileId'].every(function (key) { return typeof value[key] === 'string' && value[key].trim() && value[key].length <= 128 }) || ['learn', 'question'].indexOf(value.mode) === -1) refuse('invalid material launch')
      return value
    })
    var COMMAND_REQUEST = strict(REMOTE_PACKAGE + '#commandRequest', function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536 ||
        Object.keys(value).some(function (key) { return ['sessionId', 'action', 'args'].indexOf(key) === -1 }) ||
        typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 128 ||
        ['discover', 'confirm', 'rebuild', 'diagnostics', 'courses', 'manageCourse'].indexOf(value.action) === -1 ||
        !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) refuse('invalid workspace command')
      return value
    })
    var MEMORY_REQUEST = strict(REMOTE_PACKAGE + '#memoryRequest', function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return ['enabled', 'expectedRevision'].indexOf(key) === -1 }) ||
        typeof value.enabled !== 'boolean' || !Object.prototype.hasOwnProperty.call(value, 'expectedRevision') ||
        (value.expectedRevision !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1))) refuse('invalid memory control request')
      return value
    })
    var TYPERT_REMOTE = {
      package: REMOTE_PACKAGE,
      descriptors: [
        {
          id: REMOTE_PACKAGE + '#home/read',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'home',
          invocation: { kind: 'direct' },
          parameters: [],
          result: HOME_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#launch/create',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'launch',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: LAUNCH_REQUEST }],
          result: LAUNCH_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#reopen/validate',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'reopen',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: REOPEN_REQUEST }],
          result: REOPEN_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#clear/archive',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'clearSession',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_REQUEST }],
          result: CLEAR_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#clear-all/snapshot',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'clearAllSnapshot',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_SNAPSHOT_REQUEST }],
          result: CLEAR_ALL_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#clear-all/start',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'clearAllStart',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_START_REQUEST }],
          result: CLEAR_ALL_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#clear-all/continue',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'clearAllContinue',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_CONTINUE_REQUEST }],
          result: CLEAR_ALL_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#presets/library',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'presetLibrary',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_LIBRARY_REQUEST }],
          result: PRESET_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#presets/save',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'presetSave',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_SAVE_REQUEST }],
          result: PRESET_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#presets/delete',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'presetDelete',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_DELETE_REQUEST }],
          result: PRESET_RESULT,
        },
        {
          id: REMOTE_PACKAGE + '#presets/apply',
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: 'presetApply',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_APPLY_REQUEST }],
          result: PRESET_RESULT,
        },
        { id: REMOTE_PACKAGE + '#views/setMemoryEnabled', service: NAMESPACE, namespace: NAMESPACE, method: 'setMemoryEnabled',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MEMORY_REQUEST }], result: HOME_RESULT },
        { id: REMOTE_PACKAGE + '#views/workspaceCommand', service: NAMESPACE, namespace: NAMESPACE, method: 'workspaceCommand',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: COMMAND_REQUEST }], result: HOME_RESULT },
        { id: REMOTE_PACKAGE + '#views/launchMaterial', service: NAMESPACE, namespace: NAMESPACE, method: 'launchMaterial',
          invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MATERIAL_REQUEST }], result: HOME_RESULT },
      ].concat(['course', 'settings', 'saveCustomization'].map(function (method) {
        return { id: REMOTE_PACKAGE + '#views/' + method, service: NAMESPACE, namespace: NAMESPACE,
          method: method, invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: VIEW_REQUEST }], result: HOME_RESULT }
      })),
    }
    // #endregion

    // #region helpers
    async function prepareMaterialDraft(ctx, result, isActive) {
      function guard() { if (isActive && !isActive()) throw new Error('材料操作已取消。') }
      guard()
      if (!result || result.readyForDraft !== true || typeof result.sessionId !== 'string' || typeof result.relativePath !== 'string' ||
          !result.relativePath || result.relativePath.length > 4096 || /[\u0000-\u001f\u007f-\u009f"\\]/u.test(result.relativePath) || result.relativePath[0] === '/' || result.relativePath.split('/').indexOf('..') !== -1) throw new Error('材料上下文无效，请重新读取课程。')
      if (typeof ctx.sessions.using !== 'function') throw new Error('此 Harness 版本没有原生输入上下文接口。')
      await ctx.sessions.refresh()
      guard()
      var admission = await ctx.sessions.using(result.sessionId, { source: 'workspaceOperation' }, function (reference) {
        guard()
        var conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : ctx.conversation
        var input = conversation && conversation.input && conversation.input.for(reference.binding.ctx)
        if (!input || typeof input.addFiles !== 'function') throw new Error('原生材料引用接口不可用。')
        // Same quoted file-reference grammar and chip shape as the host's own file picker.
        var mention = '@"' + result.relativePath + '"'
        if (!input.addFiles([{ source: 'reference', ref: mention, label: result.relativePath.split('/').pop(), appearance: 'file', clipboardText: mention }], [])) throw new Error('原生输入框正在提交，请稍后重试。')
        ctx.uiWorkspace.openSession(result.sessionId)
        ctx.layout.selectPanel(null)
      })
      if (!admission.ok) throw new Error(admission.error && admission.error.message || '无法准备原生材料上下文。')
    }
    /** `<requestId>`: 12 random bytes, so a repeated click is a *new* request but never a guessable id. */
    function newRequestId() {
      var bytes = new Uint8Array(12)
      if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes)
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
      }
      var out = ''
      for (var index = 0; index < bytes.length; index++) out += bytes[index].toString(16).padStart(2, '0')
      return 'r-' + out
    }

    /** Turn whatever came back from the host into one sentence a student can act on. */
    /**
     * Unwrap one Typed Remote reply.
     *
     * The client face resolves a **result envelope**, not the value: `{ ok: true, value }` on
     * success, `{ ok: false, error }` for every failure — including the ones the host itself
     * reported, which is why a rejected promise is not the only unhappy path Home must handle.
     * The host's `RemoteError` is rethrown untouched so its `code` still reaches the UI.
     */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value
      var failure = result === null || typeof result !== 'object' ? null : result.error
      if (failure !== null && failure !== undefined && typeof failure.message === 'string') throw failure
      var error = new Error('Professor Home 暂时无法连接到 Harness。')
      error.code = 'gateway/internal'
      throw error
    }

    /**
     * Upper bound on one Remote call.
     *
     * A Remote reply that never arrives (a dropped transport settles nothing) would otherwise leave
     * the launcher busy forever with no way to retry — which is exactly the state the contract
     * forbids. Bounding the wait turns a silent hang into a visible, retryable error. Overridable so
     * a test can prove the bound without waiting for it.
     */
    var REMOTE_TIMEOUT_MS = 45000

    function withTimeout(promise, label) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          var error = new Error(label + '超时，请重试。')
          error.code = 'gateway/timeout'
          reject(error)
        }, REMOTE_TIMEOUT_MS)
        promise.then(function (value) {
          clearTimeout(timer)
          resolve(value)
        }, function (reason) {
          clearTimeout(timer)
          reject(reason)
        })
      })
    }

    function messageOf(error) {
      if (error === null || error === undefined) return 'Professor 无法完成这个操作。'
      var text = error.message || String(error)
      var code = error.code ? String(error.code) : ''
      return code.length > 0 ? text + '（' + code + '）' : text
    }

    function shortDate(value) {
      if (typeof value !== 'string') return ''
      var parsed = new Date(value)
      if (isNaN(parsed.getTime())) return ''
      return parsed.toLocaleDateString()
    }

    /**
     * Launcher label for one course: the visible course code, never the display name.
     *
     * The option's value stays the immutable `course_id`; this is only how it reads. A legacy
     * course without a usable code falls back to its id (never the long name). Duplicate codes are
     * compared case-insensitively and disambiguated with the term (`CSC3200 · Year2Term1`); when
     * the term is missing or itself duplicated, the stable course id is appended instead so two
     * options can never merge or become indistinguishable.
     */
    function courseOptionLabel(course, peers) {
      var rawCode = typeof course.course_code === 'string' ? course.course_code.trim() : ''
      if (rawCode === '') return course.course_id
      var duplicates = (peers || []).filter(function (row) {
        return row.course_id !== course.course_id
          && String(row.course_code || '').trim().toLowerCase() === rawCode.toLowerCase()
      })
      if (duplicates.length === 0) return rawCode
      var term = typeof course.term === 'string' ? course.term.trim() : ''
      var termClash = term === '' || duplicates.some(function (row) {
        return String(row.term || '').trim().toLowerCase() === term.toLowerCase()
      })
      return termClash ? rawCode + ' · ' + course.course_id : rawCode + ' · ' + term
    }
    // #endregion

    // #region components
    /**
     * One clickable row/button with a real disabled state.
     *
     * `busy` both disables the control and marks it `aria-busy`, so a double click cannot start two
     * launches and the state is announced rather than implied.
     */
    function ActionButton(props) {
      var variant = props.danger === true ? ' professor-home__button--danger'
        : props.quiet === true ? ' professor-home__button--quiet' : ''
      if (props.primary === true) variant += ' professor-home__button--primary'
      return h('button', {
        type: 'button',
        className: 'professor-home__button' + variant,
        onClick: props.onClick,
        disabled: props.disabled === true || props.busy === true,
        'aria-busy': props.busy === true ? 'true' : 'false',
        'data-professor-action': props.action,
        autoFocus: props.autoFocus === true,
        'aria-label': props.labelText,
      }, props.busy === true ? (props.busyLabel || '处理中…') : props.label)
    }

    /** A labelled field wrapper, so every control keeps an accessible name. */
    function Field(props, child) {
      return h('div', { className: 'professor-home__field' },
        h('label', { className: 'professor-home__label', htmlFor: props.id }, props.label),
        child,
        props.hint ? h('p', { className: 'professor-home__hint' }, props.hint) : null)
    }

    /**
     * The one confirmation pattern every destructive action uses.
     *
     * It names the exact target, states in plain language what will and will not be removed, and
     * offers exactly two choices — cancel and confirm — with a busy lock so a second click cannot
     * start a second operation. It never offers an Undo it cannot honour, and it surfaces the real
     * failure message when the host refuses.
     */
    function ConfirmDialog(props) {
      var dialogRef = React.useRef(null)
      React.useEffect(function () {
        var node = dialogRef.current
        if (!node) return
        var previousFocus = node.ownerDocument.activeElement
        var cancel = node.querySelector('[data-professor-action="confirm-cancel"]')
        if (cancel) cancel.focus()
        return function () {
          if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus()
        }
      }, [])
      if (!props.request) return null
      var titleId = 'professor-confirm-title'
      var bodyId = 'professor-confirm-body'
      var keyDown = function (event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (props.busy !== true) props.onCancel()
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          var node = event.currentTarget
          var controls = Array.prototype.slice.call(node.querySelectorAll('button:not([disabled])'))
          if (!controls.length) { node.focus(); return }
          var index = controls.indexOf(node.ownerDocument.activeElement)
          var next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
            : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          controls[next].focus()
        }
      }
      return h('div', { className: 'professor-home__dialog-backdrop',
        onClick: function (event) { if (event.target === event.currentTarget && props.busy !== true) props.onCancel() } },
        h('div', {
          className: 'professor-home__dialog',
          ref: dialogRef,
          tabIndex: -1,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          'aria-describedby': bodyId,
          'data-professor-dialog': props.request.kind,
          onKeyDown: keyDown,
        },
        h('h2', { className: 'professor-home__dialog-title', id: titleId }, props.title),
        h('p', { id: bodyId }, props.summary),
        h('ul', { className: 'professor-home__dialog-list' }, props.points.map(function (point, index) {
          return h('li', { key: index }, point)
        })),
        props.error ? h('p', { role: 'alert', className: 'professor-home__error' }, props.error) : null,
        h('div', { className: 'professor-home__dialog-actions' },
          ActionButton({
            action: 'confirm-cancel', label: '取消', busy: props.busy === true,
            onClick: props.onCancel,
          }),
          ActionButton({
            action: props.request.action, label: props.confirmLabel, busyLabel: props.busyLabel || '正在删除…',
            busy: props.busy === true, danger: true, labelText: props.confirmLabel + '：' + props.request.name,
            onClick: props.onConfirm,
          }))))
    }

    /** One readiness fact, shown as a chip so four states read at a glance. */
    function Chip(props) {
      return h('span', { className: 'professor-home__chip' + (props.tone ? ' professor-home__chip--' + props.tone : '') }, props.label)
    }

    /** The launcher: optional course, one of six modes, optional topic, then one click. */
    function Launcher(props) {
      var state = props.state
      var set = props.set
      return h('section', { className: 'professor-home__section', 'aria-labelledby': 'professor-home-launcher' },
        h('h2', { className: 'professor-home__heading', id: 'professor-home-launcher' }, '开始新的学习会话'),
        Field({
          id: 'professor-home-course',
          label: '课程（可选）',
          hint: props.courses.length === 0 ? '尚未连接学术文件夹，将开启通用学术会话。' : null,
        }, h('select', {
          id: 'professor-home-course',
          className: 'professor-home__select',
          value: state.courseId,
          disabled: props.busy === true,
          onChange: function (event) { set({ courseId: event.target.value }) },
        }, [
          h('option', { key: 'none', value: '' }, '不指定课程'),
        ].concat(props.courses.map(function (course) {
          return h('option', { key: course.course_id, value: course.course_id }, courseOptionLabel(course, props.courses))
        })))),
        h('fieldset', { className: 'professor-home__modes' },
          h('legend', { className: 'professor-home__label' }, '学习方式'),
          STUDY_MODES.map(function (mode) {
            return h('label', { key: mode, className: 'professor-home__mode' },
              h('input', {
                type: 'radio',
                name: 'professor-home-mode',
                value: mode,
                checked: state.mode === mode,
                disabled: props.busy === true,
                onChange: function () { set({ mode: mode }) },
              }),
              ' ' + MODE_LABELS[mode])
          })),
        Field({ id: 'professor-home-topic', label: '主题（可选）' }, h('input', {
          id: 'professor-home-topic',
          type: 'text',
          className: 'professor-home__input',
          value: state.topic,
          maxLength: 200,
          disabled: props.busy === true,
          placeholder: '例如：递归下降解析',
          onChange: function (event) { set({ topic: event.target.value }) },
        })),
        ActionButton({
          primary: true,
          action: 'launch',
          label: '开始会话',
          busyLabel: '正在准备会话…',
          busy: props.busy === true,
          disabled: false,
          onClick: props.onLaunch,
        }))
    }

    /** Recent Professor sessions, each either navigable or honestly explained. */
    function Recent(props) {
      if (props.recent.length === 0) return null
      return h('section', { className: 'professor-home__section', 'aria-labelledby': 'professor-home-recent' },
        h('div', { className: 'professor-home__heading-row' },
          h('h2', { className: 'professor-home__heading', id: 'professor-home-recent' }, '最近的 Professor 会话'),
          props.recent.length > 0 ? ActionButton({
            action: 'clear-all-conversations',
            label: '全部清除',
            quiet: true,
            busyLabel: '正在准备…',
            busy: props.clearAllBusy === true,
            disabled: props.clearAllDisabled === true,
            labelText: '清除全部 Professor 最近对话',
            onClick: function () { return props.onClearAll() },
          }) : null),
        h('ul', { className: 'professor-home__list' }, props.recent.map(function (row) {
          var action = row.usable === true
            ? ActionButton({
              action: 'reopen',
              label: '打开',
              busyLabel: '正在打开…',
              busy: props.busyId === row.sessionId,
              onClick: function () { props.onReopen(row.sessionId) },
            })
            : row.status === 'failed' ? ActionButton({
              action: 'retry-launch', label: '重试', busy: props.busyId === row.sessionId,
              onClick: function () { props.onRetry(row) },
            }) : h('span', { className: 'professor-home__hint' },
              row.status === 'failed' ? '本次未准备好，请重试或新建会话' : '会话已不存在')
          var meta = (MODE_LABELS[row.mode] || row.mode) + ' · '
            + (row.status === 'failed' ? '未完成' : shortDate(row.updatedAt))
          // Clearing is always offered for a settled row (a preparing setup must finish first),
          // and goes through one shared confirmation — never a direct mutation from this button.
          var clear = ActionButton({
            action: 'clear-conversation',
            label: '清除',
            quiet: true,
            labelText: '清除对话 ' + row.title,
            busy: props.clearBusyId === row.sessionId,
            disabled: row.status === 'preparing' || (props.clearBusyId != null && props.clearBusyId !== row.sessionId),
            onClick: function () { props.onClear(row) },
          })
          return h('li', { key: row.sessionId, className: 'professor-home__row' },
            h('div', null,
              h('span', { className: 'professor-home__row-title' }, row.title),
              h('span', { className: 'professor-home__row-meta' }, meta)),
            h('div', { className: 'professor-home__row-actions' }, action, clear))
        })))
    }
    // #endregion

    // #region Home
    function ProfessorWorkspaceSettings(props) {
      var source = React.useState(null), home = source[0], setHome = source[1]
      var editing = React.useState({ sessionId: '', folder: '' }), form = editing[0], setForm = editing[1]
      var scan = React.useState(null), proposal = scan[0], setProposal = scan[1]
      var choices = React.useState([]), selections = choices[0], setSelections = choices[1]
      var acknowledgement = React.useState(false), acknowledge = acknowledgement[0], setAcknowledge = acknowledgement[1]
      var status = React.useState({ busy: false, message: '', result: null }), state = status[0], setState = status[1]
      var pending = React.useRef(false), alive = React.useRef(true), launchToken = React.useRef(null)
      var managedState = React.useState(null), managed = managedState[0], setManaged = managedState[1]
      // The single confirmation used by every destructive course action in this panel.
      var removalState = React.useState(null), removal = removalState[0], setRemoval = removalState[1]
      function readManaged(preservedDrafts, sessionId) {
        return props.api.workspaceCommand({ sessionId: sessionId || form.sessionId, action: 'courses', args: {} }).then(function (value) {
          if (!value.courseToken || !Array.isArray(value.courses)) throw new Error('无法读取课程配置，请检查连接与权限。')
          if (alive.current) setManaged({ token: value.courseToken, rows: value.courses.map(function (course) {
            var draft = (preservedDrafts || []).find(function (row) { return row.course_id === course.course_id && row.dirty })
            return Object.assign({}, course, { archiveConfirmed: false }, draft ? { course_code: draft.course_code, display_name: draft.display_name, term: draft.term, dirty: true } : {})
          }) })
          if (alive.current) setState(function (previous) {
            return previous.message === '正在加载课程…' ? Object.assign({}, previous, { message: '' }) : previous
          })
        })
      }
      function loadManaged() {
        // Reloading the list is not a reason to lose an unsaved name or term: every dirty row is
        // carried across, exactly the way a successful save carries the *other* rows' drafts.
        var drafts = managed ? managed.rows : []
        return work('正在加载课程…', function () { return ensureSession().then(function (id) { return readManaged(drafts, id) }).then(function () { if (alive.current) setState({ busy: true, message: '', result: null }) }) })
      }
      function editManaged(index, key, value) {
        var rows = managed.rows.slice(); rows[index] = Object.assign({}, rows[index], { [key]: value }, key === 'archiveConfirmed' ? {} : { dirty: true }); setManaged({ token: managed.token, rows: rows })
      }
      /**
       * One guarded course operation.
       *
       * `confirmed` is required for `delete`, and `hooks` let a confirmation dialog follow the real
       * outcome instead of guessing: the dialog closes only on a confirmed mutation and shows the
       * host's own reason when it refuses.
       */
      function manageCourse(course, operation, confirmed, hooks) {
        if (!managed || !form.sessionId) return
        if (operation === 'archive' && !course.archiveConfirmed) { setState({ busy: false, message: '请先确认归档。原材料、笔记和记忆不会删除。', result: null }); return }
        if (operation === 'delete' && confirmed !== true) return
        return work('正在保存课程配置…', function () {
          if (props.onConnectionChanging) props.onConnectionChanging()
          var args = { courseToken: managed.token, courseId: course.course_id, operation: operation }
          if (operation === 'update') { args.displayName = course.display_name; args.term = course.term; args.courseCode = course.course_code }
          if (operation === 'delete') args.confirmDelete = true
          return props.api.workspaceCommand({ sessionId: form.sessionId, action: 'manageCourse', args: args }).then(function (value) {
            if (!Array.isArray(value.changed) || value.changed.indexOf(course.course_id) === -1 || (value.problems || []).length) {
              throw new Error((value.problems || []).join('；') || '课程操作未确认完成，请重新读取配置。')
            }
            if (alive.current) {
              setManaged(null)
              setState({ busy: true, message: operation === 'delete' ? '课程已删除，原始文件、笔记和记忆都保留。' : '已保存。', result: null })
              if (hooks && hooks.onSuccess) hooks.onSuccess()
            }
            if (!alive.current) return
            // Only the deleted course's own draft is dropped; every other row keeps its unsaved edits.
            return readManaged(managed.rows.filter(function (row) { return row.course_id !== course.course_id })).then(refresh)
          }).catch(function (error) {
            // A failed save keeps the managed rows open so the learner's draft is retained; the
            // actionable error is shown by the surrounding work() handler.
            if (hooks && hooks.onError) hooks.onError(error)
            throw error
          })
            .finally(function () { if (alive.current && props.onConnectionChanged) return props.onConnectionChanged() })
        })
      }

      function askDeleteCourse(course) {
        if (state.busy || pending.current || (removal && removal.busy)) return
        setRemoval({ course: course, busy: false, error: null })
      }

      function cancelDeleteCourse() {
        if (removal && removal.busy) return
        setRemoval(null)
      }

      function confirmDeleteCourse() {
        if (!removal || removal.busy || pending.current || !managed || !form.sessionId) return
        var course = removal.course
        setRemoval({ course: course, busy: true, error: null })
        return manageCourse(course, 'delete', true, {
          onSuccess: function () { setRemoval(null) },
          onError: function (error) {
            setRemoval(function (previous) {
              return previous === null ? null : { course: previous.course, busy: false, error: messageOf(error) }
            })
          },
        })
      }
      function refresh() {
        return props.api.home().then(function (value) { if (alive.current) setHome(value) })
      }
      function ensureSession() {
        if (form.sessionId) return Promise.resolve(form.sessionId)
        if (!launchToken.current) launchToken.current = newRequestId()
        var folder = form.folder.trim() || (home && home.connection && home.connection.folder)
        return props.api.launch(Object.assign({ requestId: launchToken.current, mode: 'free', courseId: null, topic: '课程设置' }, folder ? { folder: folder } : {})).then(function (value) {
          if (!alive.current) throw new Error('页面已关闭。')
          launchToken.current = null
          setForm(function (previous) { return Object.assign({}, previous, { sessionId: value.sessionId }) })
          return value.sessionId
        })
      }
      function chooseFolder() {
        return work('请选择材料文件夹…', function () {
          return props.api.pickFolder().then(function (folder) {
            if (!folder || !alive.current) return
            change('folder', folder)
          })
        })
      }
      function startCourse(course) {
        return work('正在打开课程…', function () {
          return props.api.launch({ requestId: newRequestId(), courseId: course.course_id, mode: 'learn', topic: '' }).then(function (value) {
            if (alive.current) return props.api.open(value.sessionId)
          })
        })
      }
      React.useEffect(function () {
        alive.current = true
        props.api.home().then(function (value) {
          if (!alive.current) return
          setHome(value)
          if (value.connection && value.connection.connected) return work('正在加载课程…', function () { return ensureSession().then(function (id) { return readManaged(null, id) }) })
        }).catch(function (error) { if (alive.current) setState({ busy: false, message: messageOf(error), result: null }) })
        return function () { alive.current = false }
      }, [])
      function work(label, operation) {
        if (pending.current) return
        pending.current = true
        setState({ busy: true, message: label, result: null })
        return Promise.resolve().then(operation).catch(function (error) {
          if (alive.current) setState({ busy: true, message: messageOf(error) + ' 请刷新状态或重新扫描后重试。', result: null })
        }).then(function () {
          pending.current = false
          if (alive.current) setState(function (previous) { return Object.assign({}, previous, { busy: false }) })
        })
      }
      function change(key, value) {
        setForm(Object.assign({}, form, { [key]: value }, key === 'folder' ? { sessionId: '' } : {}))
        if (key === 'folder') launchToken.current = null
        setProposal(null); setSelections([]); setAcknowledge(false)
        setManaged(null)
      }
      function command(action) {
        if (action === 'discover' && !form.folder.trim() && !(home && home.connection && home.connection.connected)) { setState({ busy: false, message: '请先选择材料文件夹。', result: null }); return }
        return work(action === 'discover' ? '正在扫描文件夹…' : action === 'confirm' ? '正在建立课程索引…' : '正在更新…', function () { return ensureSession().then(function (sessionId) {
          var args = action === 'discover' ? form.folder.trim() ? { folder: form.folder.trim() } : {} : {}
          if (action === 'confirm') {
            setManaged(null)
            if (!proposal) throw new Error('请先扫描文件夹。')
            if (selections.some(function (row) { return row.action === 'include' && !row.course_code.trim() })) throw new Error('纳入课程前，请填写明确的课程代码；身份不明的文件夹可以保持排除。')
            args = { proposalToken: proposal.proposalToken, selections: selections.map(function (row) {
              var choice = { relative_path: row.relative_path, action: row.action }
              if (row.action === 'include') ['course_code', 'display_name', 'term'].forEach(function (key) { if (row[key].trim()) choice[key] = row[key].trim() })
              return choice
            }), acknowledgeFolderChange: acknowledge }
            if (props.onConnectionChanging) props.onConnectionChanging()
          }
          return props.api.workspaceCommand({ sessionId: sessionId, action: action, args: args }).then(function (value) {
            if (!alive.current) return
            if (action === 'discover' && value.ok === true && value.proposal) {
              setProposal(value); setAcknowledge(false)
              setSelections(value.proposal.candidates.map(function (row) {
                var identity = row.proposed || {}
                return { relative_path: row.relative_path, action: row.confidence === 'high' && identity.course_code ? 'include' : 'exclude',
                  course_code: identity.course_code || '', display_name: identity.display_name || '', term: identity.term || '' }
              }))
            }
            if (action === 'confirm' && value.applied === true) { setProposal(null); setSelections([]); setAcknowledge(false) }
            setState({ busy: true, message: value.ok === false ? (value.problems || []).join('；') || '操作未完成，请重试。' : action === 'discover' ? '扫描完成，确认要加入的课程。' : action === 'confirm' ? '课程已保存。' : '更新完成。', result: value })
            if (action !== 'discover') return refresh().then(function () { if (action === 'confirm' && value.applied === true && alive.current) return readManaged(null, sessionId) })
          }).finally(function () { if (action === 'confirm' && alive.current && props.onConnectionChanged) return props.onConnectionChanged() })
        }) })
      }
      function choice(index, key, value) {
        var next = selections.slice(); next[index] = Object.assign({}, next[index], { [key]: value }); setSelections(next)
      }
      var readiness = state.result && state.result.readiness
      return h('section', { 'aria-labelledby': 'professor-workspace-title', 'aria-busy': state.busy },
        removal !== null ? h(ConfirmDialog, {
          request: { kind: 'course', action: 'confirm-delete-course',
            name: removal.course.display_name || removal.course.course_code || removal.course.course_id },
          title: '删除这门课程？',
          summary: '将从 Professor 中移除「'
            + (removal.course.display_name || removal.course.course_code || removal.course.course_id)
            + '」的注册信息。',
          points: [
            '这门课不再出现在主页、课程列表和可选课程中，它的检索索引也会被移除。',
            '课程原始文件、笔记、复习资料、学习进度和持久记忆都不会被删除或修改。',
            '其他课程和已有对话不受影响。',
            '之后可以重新扫描并确认同一个文件夹，把这门课加回来。',
          ],
          confirmLabel: '删除课程',
          busy: removal.busy,
          error: removal.error,
          onCancel: cancelDeleteCourse,
          onConfirm: confirmDeleteCourse,
        }) : null,
        h('h2', { id: 'professor-workspace-title' }, '选择文件夹'),
        h('p', null, home && home.connection && home.connection.connected ? '当前文件夹：' + home.connection.folder : '选择存放课件和学习材料的文件夹。'),
        ActionButton({ action: 'choose-workspace-folder', label: '选择文件夹', busy: state.busy, onClick: chooseFolder }),
        Field({ id: 'professor-workspace-folder', label: '材料文件夹' }, h('input', { id: 'professor-workspace-folder', className: 'professor-home__input', value: form.folder, placeholder: '选择文件夹，或粘贴路径', maxLength: 4096, disabled: state.busy,
          onChange: function (event) { change('folder', event.target.value) } })),
        ActionButton({ action: 'discover-workspace', label: '扫描文件夹', busy: state.busy, onClick: function () { return command('discover') } }),
        h('p', { className: 'professor-home__hint' }, '索引保存在这个文件夹的 .professor 中，原材料保持不变。'),
        state.message ? h('p', { role: 'status' }, state.message) : null,
        proposal ? h('div', null, h('h3', null, '扫描到的课程'),
          proposal.proposal.scan && proposal.proposal.scan.truncated ? h('p', { role: 'alert' }, '扫描已达到上限；结果不完整，请检查遗漏，不将它视为完整课程清单。') : null,
          selections.length === 0 ? h('p', null, '没有识别到课程候选。确认只会保存文件夹配置，不会凭空创建课程。') : null,
          selections.map(function (row, index) { return h('fieldset', { key: row.relative_path, disabled: state.busy, className: 'professor-home__field' },
            h('legend', null, row.relative_path),
            Field({ id: 'professor-candidate-choice-' + index, label: '加入课程' }, h('select', { id: 'professor-candidate-choice-' + index, className: 'professor-home__select', value: row.action,
              onChange: function (event) { choice(index, 'action', event.target.value) } }, h('option', { value: 'exclude' }, '暂不加入'), h('option', { value: 'include' }, '加入'))),
            [['course_code', '课程代码', 'code'], ['display_name', '课程名称', 'name'], ['term', '学期（可留空）', 'term']].map(function (entry) {
              var id = 'professor-candidate-' + entry[2] + '-' + index
              return Field({ id: id, label: entry[1] + ' · ' + row.relative_path }, h('input', { id: id, className: 'professor-home__input', value: row[entry[0]], maxLength: 240,
                onChange: function (event) { choice(index, entry[0], event.target.value) } }))
            })) }),
          home && home.connection && home.connection.connected && home.connection.folder !== proposal.proposal.root ? h('label', null, h('input', { type: 'checkbox', checked: acknowledge, disabled: state.busy, onChange: function (event) { setAcknowledge(event.target.checked) } }), '切换到这个文件夹（保留原文件夹的记录）') : null,
          ActionButton({ action: 'confirm-workspace', label: state.busy ? '正在保存…' : '保存课程并建立索引', busy: state.busy, onClick: function () { return command('confirm') } }),
          state.message ? h('p', { role: 'status' }, state.message) : null) : null,
        readiness ? h('div', null,
          h('div', { className: 'professor-home__chips', role: 'status' },
            h(Chip, { label: '配置 ' + (readiness.configuration.saved ? '已保存' : '未保存'), tone: readiness.configuration.saved ? 'ok' : 'pending' }),
            h(Chip, { label: '索引 ' + (readiness.index.complete ? '完成' : '未完成'), tone: readiness.index.complete ? 'ok' : 'pending' }),
            h(Chip, { label: '抽取 ' + (readiness.extraction.complete ? '完成' : '未完成'), tone: readiness.extraction.complete ? 'ok' : 'pending' }),
            h(Chip, { label: '搜索 ' + (readiness.searchable ? '可用' : '不可用'), tone: readiness.searchable ? 'ok' : 'pending' })),
          readiness.index.skipped ? h('p', { className: 'professor-home__hint' }, '已跳过 ' + readiness.index.skipped + ' 个超出扫描范围的文件（例如超过 32 MB 的文件或符号链接）。') : null,
          (readiness.partial || []).map(function (item) { return h('p', { key: item, role: 'status' }, item) })) : null,
        state.result && (state.result.warnings || []).map(function (item, index) { return h('p', { key: index, role: 'status' }, item) }),
        h('h2', null, '已配置的课程'),
        h('p', { className: 'professor-home__hint' }, '调整课程编号、课程名称和学期，然后开始学习。'),
        home && home.connection && home.connection.connected ? ActionButton({ action: 'load-managed-courses', label: '刷新课程', busy: state.busy, onClick: loadManaged }) : h('p', null, '扫描并保存文件夹后，课程会出现在这里。'),
        managed ? managed.rows.length ? managed.rows.map(function (course, index) {
          var courseName = course.display_name || course.course_code || course.course_id
          return h('fieldset', { key: course.course_id, disabled: state.busy || removal !== null, className: 'professor-home__field' },
            h('legend', null, course.course_code + ' · ' + (course.active ? '在用' : '已归档')),
            h('div', { className: 'professor-home__course-fields' },
            Field({ id: 'professor-course-code-' + course.course_id, label: '课程编号' }, h('input', { id: 'professor-course-code-' + course.course_id, className: 'professor-home__input', value: course.course_code, maxLength: 240,
              onChange: function (event) { editManaged(index, 'course_code', event.target.value) } })),
            Field({ id: 'professor-course-name-' + course.course_id, label: '课程名称' }, h('input', { id: 'professor-course-name-' + course.course_id, className: 'professor-home__input', value: course.display_name, maxLength: 240,
              onChange: function (event) { editManaged(index, 'display_name', event.target.value) } })),
            Field({ id: 'professor-course-term-' + course.course_id, label: '学期' }, h('input', { id: 'professor-course-term-' + course.course_id, className: 'professor-home__input', value: course.term, maxLength: 240,
              onChange: function (event) { editManaged(index, 'term', event.target.value) } }))),
            h('div', { className: 'professor-home__course-footer' },
            h('div', { className: 'professor-home__card-actions' },
            ActionButton({ action: 'save-course-' + course.course_id, label: '保存修改', busy: state.busy, onClick: function () { return manageCourse(course, 'update') } }),
            course.active ? ActionButton({ action: 'study-course-' + course.course_id, label: '开始学习', primary: true, busy: state.busy, onClick: function () { return startCourse(course) } }) : null),
            h('div', { className: 'professor-home__course-maintenance' },
            course.active ? h('label', { className: 'professor-home__archive-check' }, h('input', { id: 'professor-archive-' + course.course_id, type: 'checkbox', checked: course.archiveConfirmed,
              onChange: function (event) { editManaged(index, 'archiveConfirmed', event.target.checked) } }), '确认归档') : null,
            ActionButton({ action: (course.active ? 'archive-course-' : 'reactivate-course-') + course.course_id, label: course.active ? '归档课程' : '恢复课程', quiet: true, busy: state.busy,
              onClick: function () { return manageCourse(course, course.active ? 'archive' : 'reactivate') } }),
            // Deletion is available for active and archived registrations alike, and is always the
            // quietest control in the row until the confirmation is answered.
            ActionButton({ action: 'delete-course-' + course.course_id, label: '删除', quiet: true,
              labelText: '删除课程 ' + courseName, disabled: state.busy, onClick: function () { return askDeleteCourse(course) } }))))
        }) : h('p', null, '当前项目没有课程，请扫描文件夹添加。') : null,
        home && home.connection && home.connection.connected ? h('details', null, h('summary', null, '更多操作'),
          ActionButton({ action: 'rebuild-workspace', label: '更新材料索引', busy: state.busy, onClick: function () { return command('rebuild') } }),
          ActionButton({ action: 'diagnose-workspace', label: '查看状态', busy: state.busy, onClick: function () { return command('diagnostics') } })) : null,
        state.result && state.result.plugin ? h('div', null,
          h('h3', null, '运行状态'),
          h('p', null, '插件版本：' + state.result.plugin.version),
          h('p', null, '项目文件：' + (state.result.project && state.result.project.projectFile || '未知') + '；课程数：' + (state.result.project && state.result.project.courses && state.result.project.courses.total != null ? state.result.project.courses.total : '未知')),
          h('p', null, '文件服务：' + (state.result.sandbox && state.result.sandbox.fsAvailable === true ? '可用' : '未确认') + '；抽取执行器：' + (state.result.runtime && state.result.runtime.extraction_runner || '未知')),
          h('p', null, '记忆状态：' + (state.result.memory && typeof state.result.memory.enabled === 'boolean' ? state.result.memory.enabled ? '开启' : '关闭' : '未知')),
          (state.result.limitations || []).map(function (row, index) { return h('p', { key: index, className: 'professor-home__hint' }, row.feature) })) : null)
    }
    /**
     * One stylesheet for every Professor surface.
     *
     * It is built from the installed host's own design tokens (`--dsw-alias-*`, `--dsw-radius-*`,
     * `--dsw-focus-ring-*`) so light and dark come from Harness itself and no global style is
     * touched; each token carries a local fallback that keeps the page legible on a host that does
     * not publish it. Everything is scoped under `.professor-home`.
     */
    var PROFESSOR_STYLE = [
      '.professor-home{',
      '--p-text:var(--dsw-alias-label-primary,CanvasText);',
      '--p-muted:var(--dsw-alias-label-secondary,color-mix(in srgb,CanvasText 72%,Canvas));',
      '--p-faint:var(--dsw-alias-label-tertiary,color-mix(in srgb,CanvasText 55%,Canvas));',
      '--p-line:var(--dsw-alias-border-l3,color-mix(in srgb,CanvasText 16%,Canvas));',
      '--p-line-soft:var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 10%,Canvas));',
      '--p-card:var(--dsw-alias-bg-layer-1,color-mix(in srgb,CanvasText 4%,Canvas));',
      '--p-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,CanvasText 7%,Canvas));',
      '--p-accent:var(--dsw-alias-state-business-primary,#2f6b58);',
      '--p-on-accent:var(--dsw-alias-label-primary-inverted,#ffffff);',
      '--p-danger:var(--dsw-alias-state-error-primary,#c0392b);',
      '--p-radius:var(--dsw-radius-md,8px);',
      '--p-radius-sm:var(--dsw-radius-sm,6px);',
      '--p-radius-lg:var(--dsw-radius-lg,12px);',
      '--p-focus:var(--dsw-focus-ring-color,var(--p-accent));',
      'font:inherit;color:var(--p-text);width:100%;max-width:820px;min-width:0;margin:0 auto;',
      'padding:28px 24px 40px;box-sizing:border-box;height:100%;overflow:auto;overflow-wrap:anywhere;line-height:1.55}',
      '.professor-home h1,.professor-home__title{font-family:inherit;font-size:24px;font-weight:600;letter-spacing:-.01em;margin:0}',
      '.professor-home h2,.professor-home__heading{font-family:inherit;font-size:16px;font-weight:600;letter-spacing:-.005em;margin:0 0 12px}',
      '.professor-home h3{font-family:inherit;font-size:14px;font-weight:600;margin:16px 0 8px}',
      '.professor-home p{margin:0 0 8px}',
      '.professor-home__header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.professor-home__section{border-top:1px solid var(--p-line-soft);margin-top:24px;padding-top:20px}',
      '.professor-home__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}',
      '.professor-home__row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0;padding:8px 10px;border-radius:var(--p-radius-sm)}',
      '.professor-home__row:hover{background:var(--p-hover)}',
      '.professor-home__row-title{font-size:13.5px;min-width:0;overflow-wrap:anywhere}',
      '.professor-home__row-meta{display:block;font-size:12px;color:var(--p-faint);margin-top:2px}',
      '.professor-home__card{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;min-width:0;padding:14px 16px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius);background:var(--p-card)}',
      '.professor-home__card-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 200px}',
      '.professor-home__card-title{font-size:14.5px;font-weight:600;overflow-wrap:anywhere}',
      '.professor-home__card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.professor-home__row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.professor-home__heading-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.professor-home__bulk-result{margin:8px 0;padding:10px 12px;border-radius:var(--p-radius-sm);border:1px solid var(--p-line-soft);background:var(--p-card)}',
      '.professor-home__preset-card{padding:12px 14px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius-sm);background:var(--p-card);margin:0 0 8px}',
      '.professor-home__preset-title{font-weight:600}',
      '.professor-home__preset-active{border-color:color-mix(in srgb,var(--p-accent) 45%,transparent)}',
      '.professor-home__continue{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:20px;padding:14px 16px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius);background:var(--p-card)}',
      '.professor-home__continue .professor-home__heading{font-size:12.5px;color:var(--p-faint);margin-bottom:4px;letter-spacing:.02em}',
      '.professor-home__field{margin:14px 0}',
      '.professor-home__label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}',
      '.professor-home__hint{font-size:12.5px;color:var(--p-faint);margin:0 0 8px}',
      '.professor-home__empty{color:var(--p-muted);line-height:1.7;margin:0}',
      '.professor-home__error{color:var(--p-danger);font-size:13.5px}',
      '.professor-home [role=status]{font-size:13px;color:var(--p-muted);margin:8px 0}',
      '.professor-home [role=alert]{font-size:13px;color:var(--p-danger);margin:8px 0}',
      '.professor-home__input,.professor-home__select,textarea{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid var(--p-line);border-radius:var(--p-radius-sm);background:transparent;color:var(--p-text);font:inherit;font-size:14px}',
      'textarea{resize:vertical;min-height:84px}',
      '.professor-home__select{cursor:pointer}',
      '.professor-home input::placeholder,.professor-home textarea::placeholder{color:var(--p-faint)}',
      '.professor-home fieldset{min-width:0;margin:12px 0;padding:12px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius)}',
      '.professor-home__modes{margin:0;padding:0;border:0;display:flex;gap:8px;flex-wrap:wrap}',
      '.professor-home__mode{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius-sm);font-size:13px;cursor:pointer;background:transparent}',
      '.professor-home__mode:hover{background:var(--p-hover)}',
      '.professor-home input[type=checkbox],.professor-home input[type=radio]{accent-color:var(--p-accent);margin:0}',
      '.professor-home__button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 12px;margin:0;border:1px solid var(--p-line);border-radius:var(--p-radius-sm);background:transparent;color:var(--p-text);font:inherit;font-size:13px;line-height:1.4;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,color .12s ease}',
      '.professor-home__button:hover:not(:disabled){background:var(--p-hover)}',
      '.professor-home__button:focus-visible,.professor-home__input:focus-visible,.professor-home__select:focus-visible,.professor-home textarea:focus-visible,.professor-home__mode:focus-within{outline:2px solid var(--p-focus);outline-offset:2px}',
      '.professor-home__button:disabled{opacity:.55;cursor:default}',
      '.professor-home__button--primary{background:var(--p-accent);border-color:var(--p-accent);color:var(--p-on-accent);font-weight:600}',
      '.professor-home__button--primary:hover:not(:disabled){background:var(--p-accent);filter:brightness(1.08)}',
      '.professor-home__button--quiet{border-color:transparent;color:var(--p-muted);padding:6px 8px}',
      '.professor-home__button--quiet:hover:not(:disabled){background:transparent;color:var(--p-danger)}',
      '.professor-home__button--danger{background:var(--p-danger);border-color:var(--p-danger);color:#fff;font-weight:600}',
      '.professor-home__button--danger:hover:not(:disabled){background:var(--p-danger);filter:brightness(1.08)}',
      '.professor-home__chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}',
      '.professor-home__chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius-sm);background:var(--p-card);font-size:12.5px;color:var(--p-muted)}',
      '.professor-home__chip--ok{color:var(--p-text)}',
      '.professor-home__chip--pending{color:var(--p-faint)}',
      '.professor-home__material{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0;padding:10px 12px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius-sm)}',
      '.professor-home__material-name{font-size:13.5px;min-width:0;overflow-wrap:anywhere}',
      '.professor-home__settings-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;margin-top:20px;align-items:start}',
      '.professor-home__settings-nav{display:flex;flex-direction:row;gap:6px;flex-wrap:wrap;align-self:start;padding-bottom:12px;border-bottom:1px solid var(--p-line-soft)}',
      '.professor-home__settings-nav button{justify-content:flex-start;text-align:left;min-height:34px;padding:8px 12px}',
      '.professor-home__settings-nav button[aria-pressed=true]{border-color:color-mix(in srgb,var(--p-accent) 45%,transparent);background:color-mix(in srgb,var(--p-accent) 14%,transparent);color:var(--p-text);font-weight:600}',
      '.professor-home__settings-content{min-width:0}',
      '.professor-home__preference-card{padding:18px;border:1px solid var(--p-line-soft);border-radius:var(--p-radius);background:var(--p-card)}',
      '.professor-home__preference-grid,.professor-home__course-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 18px}',
      '.professor-home__course-fields{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}',
      '.professor-home__course-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid var(--p-line-soft);padding-top:14px;margin-top:8px}',
      '.professor-home__course-maintenance{display:flex;align-items:center;flex-wrap:wrap;gap:10px}',
      '.professor-home__archive-check{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--p-muted)}',
      '.professor-home__advanced{margin-top:16px;border-top:1px solid var(--p-line-soft);padding-top:14px}',
      '.professor-home__advanced summary{cursor:pointer;font-size:13px;color:var(--p-muted)}',
      '.professor-home__settings-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px}',
      '.professor-home [hidden]{display:none!important}',
      '.professor-home__dialog-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,#000 45%,transparent)}',
      '.professor-home__dialog{width:min(440px,100%);max-height:88vh;overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--p-line);border-radius:var(--p-radius-lg);background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--p-text);box-shadow:var(--dsw-elevation-panel,0 16px 40px rgba(0,0,0,.28))}',
      '.professor-home__dialog-title{font-size:16px;font-weight:600;margin:0 0 10px}',
      '.professor-home__dialog-list{margin:8px 0 12px;padding-left:18px;font-size:13.5px;color:var(--p-muted)}',
      '.professor-home__dialog-list li{margin:4px 0}',
      '.professor-home__dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}',
      '.professor-home__skeleton{padding:14px 0;color:var(--p-muted);font-size:13.5px}',
      '@media(max-width:680px){.professor-home{padding:20px 16px 32px}',
      '.professor-home__preference-grid,.professor-home__course-fields{grid-template-columns:minmax(0,1fr)}',
      '.professor-home__settings-layout{grid-template-columns:minmax(0,1fr);gap:16px}',
      '.professor-home__settings-nav{flex-direction:row;flex-wrap:wrap}',
      '.professor-home__card,.professor-home__continue{flex-direction:column;align-items:stretch}',
      '.professor-home__card-actions{justify-content:flex-start}.professor-home__dialog-actions{justify-content:stretch}',
      '.professor-home__dialog-actions .professor-home__button{flex:1 1 auto}}',
    ].join('')
    /**
     * Derive a valid, non-reserved user id for a copied definition.
     *
     * Built-in ids are reserved by production validation (`builtin-` prefix and every bundled id),
     * so a copy may never keep the `builtin-` form: the prefix is stripped, the result is bounded
     * to the 64-character id budget, and collisions with existing user ids or repeated copies of
     * the same definition advance through `-copy`, `-copy-2`, … instead of silently overwriting.
     */
    function presetCopyId(baseId, taken) {
      var stripped = String(baseId || '').replace(/^builtin-/, '')
      stripped = stripped.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      if (stripped === '' || !/^[a-z0-9]/.test(stripped)) stripped = 'my-preset'
      var candidate = stripped.slice(0, 64)
      if (!taken(candidate)) return candidate
      for (var n = 1; ; n++) {
        var suffix = '-copy' + (n > 1 ? '-' + n : '')
        candidate = stripped.slice(0, 64 - suffix.length).replace(/-+$/g, '') + suffix
        if (!taken(candidate)) return candidate
      }
    }

    /**
     * The learning-preset library: bundled teaching modes plus the user's own saved definitions.
     *
     * These are teaching behaviours, not Harness deployment presets or model choices. A definition
     * is never activated by saving it; activation is the explicit 使用此预设 (or 恢复自动 to return
     * to the composed default). Built-ins can be copied (另存为) but not overwritten or deleted.
     */
    function LearningPresets(props) {
      var presets = props.presets
      var selected = React.useState(null), selectedId = selected[0], setSelectedId = selected[1]
      var editorState = React.useState(null), editor = editorState[0], setEditor = editorState[1]
      var deleteState = React.useState(null), deleting = deleteState[0], setDeleting = deleteState[1]
      var editorPending = React.useRef(false)
      var FIELD_LABELS = { language: '讲解语言', teachingDepth: '详细程度', explanationStyle: '讲解方式', programmingLanguage: '编程语言', additionalInstructions: '讲解说明' }
      var all = (presets.bundled || []).map(function (row) { return Object.assign({ builtin: true }, row) })
        .concat((presets.user || []).map(function (row) { return Object.assign({ builtin: false }, row) }))
      var selectedDef = all.filter(function (row) { return row.id === selectedId })[0] || null
      var applied = presets.applied

      function openEditor(mode, definition) {
        var existing = {}
        ;(presets.user || []).forEach(function (row) { existing[row.id] = true })
        ;(presets.bundled || []).forEach(function (row) { existing[row.id] = true })
        setEditor({
          mode: mode,
          // Copies (including copies of built-ins) get a valid, non-reserved, unique id; only a
          // plain 新建 starts blank for the learner to fill in.
          id: mode === 'edit' ? definition.id
            : definition ? presetCopyId(definition.id, function (candidate) {
              return existing[candidate] === true || /^builtin-/.test(candidate)
            }) : '',
          name: definition ? definition.name : '',
          description: definition ? definition.description : '',
          fields: Object.assign({}, definition ? definition.fields : {}),
          error: null,
        })
      }

      function submitEditor() {
        if (!editor || editorPending.current) return
        var id = String(editor.id || '').trim()
        var name = String(editor.name || '').trim()
        var description = String(editor.description || '').trim()
        var instructions = String(editor.fields.additionalInstructions || '')
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { setEditor(Object.assign({}, editor, { error: 'ID 只能包含小写字母、数字和连字符。' })); return }
        if (editor.mode !== 'edit') {
          var collision = /^builtin-/.test(id) || ((presets.bundled || []).some(function (row) { return row.id === id }))
            || ((presets.user || []).some(function (row) { return row.id === id }))
          if (collision) { setEditor(Object.assign({}, editor, { error: '这个 ID 已被占用（内置预设的 ID 不可使用）。请换一个 ID，避免覆盖其它预设。' })); return }
        }
        if (name.length === 0 || name.length > 80) { setEditor(Object.assign({}, editor, { error: '名称需为 1–80 个字符。' })); return }
        if (description.length === 0 || description.length > 240) { setEditor(Object.assign({}, editor, { error: '简介需为 1–240 个字符。' })); return }
        if (instructions.length > 2048) { setEditor(Object.assign({}, editor, { error: '讲解说明超过 2048 字符上限，未保存任何内容。' })); return }
        editorPending.current = true
        var fields = {}
        Object.keys(editor.fields).forEach(function (key) {
          var value = String(editor.fields[key] || '').trim()
          if (value !== '') fields[key] = value
        })
        return props.onSave({ id: id, name: name, description: description, fields: fields, version: 1 })
          .then(function () { editorPending.current = false; setEditor(null) })
          .catch(function (error) {
            editorPending.current = false
            setEditor(Object.assign({}, editor, { error: props.messageOf(error) }))
          })
      }

      function changesAgainstOverlay(definition) {
        var rows = []
        Object.keys(definition.fields || {}).forEach(function (key) {
          var next = definition.fields[key]
          var current = (presets.overlay || {})[key] || ''
          if (next !== current) rows.push({ key: key, label: FIELD_LABELS[key] || key, from: current, to: next })
        })
        return rows
      }

      return h('div', { className: 'professor-home__preset-library' },
        h('h3', null, '学习预设'),
        h('p', { className: 'professor-home__hint' }, '学习预设决定讲解方式（教学偏好），不影响 Harness 部署预设与模型选择。' +
          (applied ? applied.state === 'customized' ? '当前：已自定义。' : '当前：已应用「' + ((all.filter(function (row) { return row.id === applied.presetId })[0] || {}).name || applied.presetId) + '」。' : presets.automaticDefault ? '当前：自动（默认「循序讲解」）。' : '当前：未选择预设。')),
        all.map(function (definition) {
          var isActive = applied && applied.state === 'preset' && applied.presetId === definition.id
          var isCustomized = applied && applied.state === 'customized' && applied.presetId === definition.id
          return h('div', { key: definition.id, className: 'professor-home__preset-card' + (isActive ? ' professor-home__preset-active' : '') },
            h('div', { className: 'professor-home__card-body' },
              h('span', { className: 'professor-home__preset-title' }, definition.name,
                definition.builtin ? '（内置）' : '（自定义）',
                isActive ? ' — 使用中' : isCustomized ? ' — 已自定义' : ''),
              h('span', { className: 'professor-home__row-meta' }, definition.description)),
            h('div', { className: 'professor-home__card-actions' },
              ActionButton({ action: 'preview-preset-' + definition.id, label: selectedId === definition.id ? '收起预览' : '预览', quiet: true,
                onClick: function () { setSelectedId(selectedId === definition.id ? null : definition.id) } }),
              ActionButton({ action: 'apply-preset-' + definition.id, label: '使用此预设', primary: true, disabled: props.busy || isActive,
                busy: props.applyingId === definition.id,
                onClick: function () { return props.onApply(definition.id) } }),
              ActionButton({ action: 'copy-preset-' + definition.id, label: '另存为', quiet: true, disabled: props.busy,
                onClick: function () { openEditor('copy', definition) } }),
              definition.builtin ? null : ActionButton({ action: 'edit-preset-' + definition.id, label: '编辑', quiet: true, disabled: props.busy,
                onClick: function () { openEditor('edit', definition) } }),
              definition.builtin ? null : ActionButton({ action: 'delete-preset-' + definition.id, label: '删除', quiet: true, disabled: props.busy,
                onClick: function () { setDeleting(definition) } })),
            selectedId === definition.id ? h('div', { className: 'professor-home__preset-preview' },
              h('p', { className: 'professor-home__hint' }, '讲解说明：' + ((definition.fields || {}).additionalInstructions || '（无）')),
              h('ul', { className: 'professor-home__dialog-list' }, changesAgainstOverlay(definition).map(function (row) {
                return h('li', { key: row.key }, row.label + '：改为「' + (row.to.length > 60 ? row.to.slice(0, 60) + '…' : row.to) + '」' + (row.from ? '（当前：' + (row.from.length > 30 ? row.from.slice(0, 30) + '…' : row.from) + '）' : ''))
              })),
              h('p', { className: 'professor-home__hint' }, '未列出的偏好保持不变。使用后从下一次讲解开始生效。')) : null)
        }),
        h('div', { className: 'professor-home__card-actions' },
          ActionButton({ action: 'new-preset', label: '新建预设', quiet: true, disabled: props.busy, onClick: function () { openEditor('new', null) } }),
          ActionButton({ action: 'restore-automatic', label: '恢复自动', quiet: true, disabled: props.busy || presets.automaticDefault, onClick: function () { return props.onRestoreAutomatic() } })),

        editor !== null ? h('div', { className: 'professor-home__preset-card' },
          h('h4', null, editor.mode === 'edit' ? '编辑预设' : editor.mode === 'copy' ? '另存为新预设' : '新建预设'),
          Field({ id: 'professor-preset-id', label: 'ID（保存后不可改）' }, h('input', { id: 'professor-preset-id', className: 'professor-home__input', value: editor.id, maxLength: 64,
            disabled: editor.mode === 'edit' || editorPending.current, onChange: function (event) { setEditor(Object.assign({}, editor, { id: event.target.value })) } })),
          Field({ id: 'professor-preset-name', label: '名称（最多 80 字）' }, h('input', { id: 'professor-preset-name', className: 'professor-home__input', value: editor.name, maxLength: 80,
            disabled: editorPending.current, onChange: function (event) { setEditor(Object.assign({}, editor, { name: event.target.value })) } })),
          Field({ id: 'professor-preset-description', label: '简介（最多 240 字）' }, h('input', { id: 'professor-preset-description', className: 'professor-home__input', value: editor.description, maxLength: 240,
            disabled: editorPending.current, onChange: function (event) { setEditor(Object.assign({}, editor, { description: event.target.value })) } })),
          Field({ id: 'professor-preset-depth', label: '详细程度' }, h('select', { id: 'professor-preset-depth', className: 'professor-home__select', value: editor.fields.teachingDepth || '', disabled: editorPending.current,
            onChange: function (event) { var next = Object.assign({}, editor.fields); next.teachingDepth = event.target.value; setEditor(Object.assign({}, editor, { fields: next })) } },
            h('option', { value: '' }, '不变'), [['简洁，先给关键结论', '简洁'], ['适中，解释关键步骤', '适中'], ['深入，逐步解释原理和推导', '深入']].map(function (choice) { return h('option', { key: choice[0], value: choice[0] }, choice[1]) }))),
          Field({ id: 'professor-preset-style', label: '讲解方式' }, h('select', { id: 'professor-preset-style', className: 'professor-home__select', value: editor.fields.explanationStyle || '', disabled: editorPending.current,
            onChange: function (event) { var next = Object.assign({}, editor.fields); next.explanationStyle = event.target.value; setEditor(Object.assign({}, editor, { fields: next })) } },
            h('option', { value: '' }, '不变'), [['先解释直觉，再给定义和例子', '直觉与例子'], ['按步骤讲解，每步说明原因', '一步一步'], ['通过问题引导，先让我尝试', '提问引导']].map(function (choice) { return h('option', { key: choice[0], value: choice[0] }, choice[1]) }))),
          Field({ id: 'professor-preset-instructions', label: '讲解说明（最多 2048 字，超出不会被截断保存）' }, h('textarea', { id: 'professor-preset-instructions', className: 'professor-home__input', value: editor.fields.additionalInstructions || '', maxLength: 2048,
            rows: 4, disabled: editorPending.current, onChange: function (event) { var next = Object.assign({}, editor.fields); next.additionalInstructions = event.target.value; setEditor(Object.assign({}, editor, { fields: next })) } })),
          editor.error ? h('p', { role: 'alert', className: 'professor-home__error' }, editor.error) : null,
          h('div', { className: 'professor-home__card-actions' },
            ActionButton({ action: 'save-preset', label: '保存预设', primary: true, busy: editorPending.current, onClick: submitEditor }),
            ActionButton({ action: 'cancel-preset', label: '取消', quiet: true, disabled: editorPending.current, onClick: function () { setEditor(null) } })),
          h('p', { className: 'professor-home__hint' }, '保存不会立刻启用；保存后请在上方点「使用此预设」。')) : null,

        deleting !== null ? h(ConfirmDialog, {
          request: { kind: 'preset', action: 'confirm-delete-preset', name: deleting.name },
          title: '删除这个预设？',
          summary: '将从你的预设库删除「' + deleting.name + '」。',
          points: [
            '已经应用的讲解设置不会被删除或改动。',
            '内置预设不能删除。',
          ],
          confirmLabel: '删除预设',
          busyLabel: '正在删除…',
          busy: false,
          error: deleting.error || null,
          onCancel: function () { setDeleting(null) },
          onConfirm: function () {
            return props.onDelete(deleting.id).then(function () { setDeleting(null) })
              .catch(function (error) { setDeleting(Object.assign({}, deleting, { error: props.messageOf(error) })) })
          },
        }) : null)
    }

    function ProfessorDetails(props) {
      var result = React.useState({ data: null, error: null }), view = result[0], setView = result[1]
      var preferences = React.useState({}), fields = preferences[0], setFields = preferences[1]
      var selection = React.useState({ courseId: props.courseId || '', skill: 'professor-study' }), selector = selection[0], setSelector = selection[1]
      var working = React.useState(false), busy = working[0], setBusy = working[1]
      var notice = React.useState(''), message = notice[0], setMessage = notice[1]
      var workspace = React.useState(false), workspaceBusy = workspace[0], setWorkspaceBusy = workspace[1]
      var applying = React.useState(null), presetApplying = applying[0], setPresetApplying = applying[1]
      var sequence = React.useRef(0), pending = React.useRef(false), launchToken = React.useRef(null)
      var sectionState = React.useState('preferences'), activeSection = sectionState[0], setActiveSection = sectionState[1]
      var materialToken = React.useRef(null)
      var isSettings = props.page === 'settings'
      function load(preserveDraft) {
        var ticket = ++sequence.current
        setBusy(true)
        var request = isSettings ? { courseId: selector.courseId || null, skill: selector.skill } : { courseId: props.courseId }
        return props.api[isSettings ? 'settings' : 'course'](request).then(function (data) {
          if (sequence.current !== ticket) return
          setView({ data: data, error: null })
          if (isSettings && preserveDraft !== true) setFields(Object.assign({}, data.overlay.fields))
        }).catch(function (error) {
          if (sequence.current === ticket) setView({ data: null, error: messageOf(error) })
        }).then(function () { if (sequence.current === ticket) setBusy(false) })
      }
      React.useEffect(function () {
        load()
        return function () { sequence.current++ }
      }, [props.page, props.courseId, selector.courseId, selector.skill])
      function save(reset) {
        if (pending.current || busy || workspaceBusy || !view.data) return
        pending.current = true
        setBusy(true); setMessage('')
        return props.api.saveCustomization({ skill: selector.skill, courseId: selector.courseId || null,
          fields: reset ? {} : fields, reset: reset, expectedRevision: view.data.overlay.revision })
          .then(function () { setMessage(reset ? '已重置。课程未设置的字段将继承全局偏好。' : '已保存。重新加载技能或新会话会读取最新设置。'); return load() })
          .catch(function (error) { setMessage(messageOf(error)) })
          .then(function () { pending.current = false; setBusy(false) })
      }
      function applyPreset(presetId) {
        if (pending.current || busy || workspaceBusy || !view.data || !view.data.presets) return Promise.resolve()
        pending.current = true; setBusy(true); setMessage(''); setPresetApplying(presetId)
        return props.api.presetApply({ presetId: presetId, courseId: selector.courseId || null, expectedRevision: view.data.presets.overlayRevision })
          .then(function () { setMessage('已使用该预设。从下一次讲解开始生效，正在进行的讲解不受影响。'); return load() })
          .catch(function (error) { setMessage(messageOf(error)) })
          .then(function () { pending.current = false; setBusy(false); setPresetApplying(null) })
      }
      function savePreset(definition) {
        if (!view.data || !view.data.presets) return Promise.reject(new Error('预设库尚未载入，请重新读取设置。'))
        return props.api.presetSave({ definition: definition, expectedRevision: view.data.presets.userRevision })
          .then(function () { setMessage('预设已保存，尚未启用。需要时点「使用此预设」。'); return load() })
      }
      function deletePreset(presetId) {
        if (!view.data || !view.data.presets) return Promise.reject(new Error('预设库尚未载入，请重新读取设置。'))
        return props.api.presetDelete({ presetId: presetId, expectedRevision: view.data.presets.userRevision, confirmed: true })
          .then(function () { setMessage('预设已删除。已应用的讲解设置保持不变。'); return load() })
      }
      function study(mode) {
        if (pending.current || busy) return
        pending.current = true; setBusy(true)
        if (!launchToken.current || launchToken.current.mode !== mode) launchToken.current = { requestId: newRequestId(), mode: mode }
        return props.api.launch({ requestId: launchToken.current.requestId, mode: mode, courseId: props.courseId, topic: null })
          .then(function (data) { return props.api.open(data.sessionId) })
          .then(function () { launchToken.current = null })
          .catch(function (error) { setMessage(messageOf(error)) })
          .then(function () { pending.current = false; setBusy(false) })
      }
      function studyMaterial(row, mode) {
        if (pending.current || busy) return
        pending.current = true; setBusy(true); setMessage('正在核对原文件并准备原生上下文…')
        var key = row.fileId + ':' + mode
        if (!materialToken.current || materialToken.current.key !== key) materialToken.current = { key: key, requestId: newRequestId() }
        var requestId = materialToken.current.requestId
        var ticket = sequence.current
        return props.api.launchMaterial({ requestId: requestId, courseId: props.courseId, fileId: row.fileId, mode: mode })
          .then(function (result) { if (sequence.current === ticket) return props.api.openMaterial(result, requestId, function () { return sequence.current === ticket }) })
          .then(function () { materialToken.current = null })
          .catch(function (error) { if (sequence.current === ticket) setMessage(messageOf(error)) })
          .then(function () { pending.current = false; if (sequence.current === ticket) setBusy(false) })
      }
      function toggleMemory() {
        if (pending.current || busy || !view.data || view.data.memory.status !== 'available') return
        var control = view.data.memory, ticket = sequence.current
        pending.current = true; setBusy(true); setMessage('')
        return props.api.setMemoryEnabled({ enabled: !control.enabled, expectedRevision: control.revision })
          .then(function (result) {
            if (sequence.current !== ticket) return
            setMessage(result.refresh === 'failed' ? '开关已保存，但活动会话刷新失败。请重新打开会话后使用。' : result.enabled ? '持久记忆已开启。' : '持久记忆已关闭，已有数据保留。')
            return load(true)
          }).catch(function (error) {
            if (sequence.current !== ticket) return
            setMessage(messageOf(error) + ' 请重新读取设置后重试。')
            return load(true)
          }).then(function () { pending.current = false; if (sequence.current >= ticket) setBusy(false) })
      }
      function connectionChanging() {
        if (pending.current) throw new Error('请等待当前偏好保存完成，再确认文件夹。')
        pending.current = true
        sequence.current++
        setWorkspaceBusy(true)
        setSelector({ courseId: '', skill: selector.skill })
        setFields({}); setView({ data: null, error: null })
        setMessage('文件夹配置正在确认；已清除旧课程草稿并暂停偏好保存。')
      }
      function connectionChanged() {
        var ticket = ++sequence.current
        return props.api.settings({ courseId: null, skill: selector.skill }).then(function (next) {
          if (sequence.current !== ticket) return
          setView({ data: next, error: null }); setFields(Object.assign({}, next.overlay.fields))
        }).catch(function (error) {
          if (sequence.current === ticket) setView({ data: null, error: messageOf(error) })
        }).then(function () { pending.current = false; setWorkspaceBusy(false); setMessage('') })
      }
      var data = view.data
      function preferenceControl(key, label, options) {
        var id = 'professor-preference-' + key
        var value = fields[key] || ''
        var choices = options.slice()
        if (value && !choices.some(function (choice) { return choice[0] === value })) choices.push([value, value])
        return Field({ id: id, label: label }, h('select', {
          id: id, className: 'professor-home__select', value: value, disabled: busy || workspaceBusy,
          onChange: function (event) { var next = Object.assign({}, fields); next[key] = event.target.value; setFields(next) },
        }, h('option', { value: '' }, selector.courseId ? '跟随通用偏好' : '自动'),
        choices.map(function (choice) { return h('option', { key: choice[0], value: choice[0] }, choice[1]) })))
      }
      var preferencePanel = data && isSettings ? h('section', { id: 'professor-panel-preferences', hidden: activeSection !== 'preferences', 'aria-label': '学习偏好' },
          h('h2', null, '学习偏好'),
          h('p', { className: 'professor-home__hint' }, '按你习惯的方式讲解。留在“自动”也可以直接开始学习。'),
          selector.skill === 'professor-study' && data.presets ? h(LearningPresets, {
            presets: data.presets,
            busy: busy || workspaceBusy,
            applyingId: presetApplying,
            messageOf: messageOf,
            onApply: applyPreset,
            onSave: savePreset,
            onDelete: deletePreset,
            onRestoreAutomatic: function () { return save(true) },
          }) : null,
          h('div', { className: 'professor-home__preference-card' },
          Field({ id: 'professor-settings-scope', label: '这些偏好用于' }, h('select', { id: 'professor-settings-scope', className: 'professor-home__select', value: selector.courseId, disabled: busy || workspaceBusy,
            onChange: function (event) { setSelector({ courseId: event.target.value, skill: selector.skill }); setView({ data: null, error: null }); setMessage('') } },
          h('option', { value: '' }, '所有课程'), (data.courses || props.courses || []).map(function (course) { return h('option', { key: course.course_id, value: course.course_id }, course.display_name || course.course_code) }))),
          selector.courseId ? h('p', { className: 'professor-home__hint' }, '未单独设置的选项会沿用通用偏好。') : null,
          h('div', { className: 'professor-home__preference-grid' },
            preferenceControl('language', '讲解语言', [['中文', '中文'], ['English', 'English'], ['中英双语，专业术语保留英文', '中英双语']]),
            preferenceControl('teachingDepth', '详细程度', [['简洁，先给关键结论', '简洁'], ['适中，解释关键步骤', '适中'], ['深入，逐步解释原理和推导', '深入']]),
            preferenceControl('explanationStyle', '讲解方式', [['先解释直觉，再给定义和例子', '直觉与例子'], ['按步骤讲解，每步说明原因', '一步一步'], ['通过问题引导，先让我尝试', '提问引导']])),
          h('details', { className: 'professor-home__advanced' }, h('summary', null, '更多设置'),
          Field({ id: 'professor-settings-skill', label: '调整哪类任务' }, h('select', { id: 'professor-settings-skill', className: 'professor-home__select', value: selector.skill, disabled: busy || workspaceBusy,
            onChange: function (event) { setSelector({ courseId: selector.courseId, skill: event.target.value }); setView({ data: null, error: null }); setMessage('') } },
            [['study', '学习讲解'], ['notes', '整理笔记'], ['review', '复习备考'], ['research', '资料研究'], ['latex', '排版文档'], ['course-management', '课程整理']].map(function (entry) { return h('option', { key: entry[0], value: 'professor-' + entry[0] }, entry[1]) }))),
          [['programmingLanguage', '编程语言（可留空）', 120], ['additionalInstructions', '其他偏好（可留空）', 2048]].map(function (entry) {
            var id = 'professor-preference-' + entry[0]
            return Field({ id: id, label: entry[1] }, h(entry[0] === 'additionalInstructions' ? 'textarea' : 'input', {
              id: id, className: 'professor-home__input', value: fields[entry[0]] || '', maxLength: entry[2], disabled: busy || workspaceBusy,
              onChange: function (event) { var next = Object.assign({}, fields); next[entry[0]] = event.target.value; setFields(next) },
            }))
          })),
          h('div', { className: 'professor-home__course-footer' },
            ActionButton({ action: 'save-customization', label: '保存偏好', primary: true, busy: busy || workspaceBusy, onClick: function () { save(false) } }),
            h('div', { className: 'professor-home__card-actions' },
              ActionButton({ action: 'refresh-settings', label: '重新读取', quiet: true, busy: busy, onClick: load }),
              ActionButton({ action: 'reset-customization', label: selector.courseId ? '跟随通用偏好' : '恢复自动', quiet: true, busy: busy || workspaceBusy, onClick: function () { save(true) } }))),
          h('p', { className: 'professor-home__hint' }, '当前偏好用于' + ({ 'professor-study': '学习讲解', 'professor-notes': '整理笔记', 'professor-review': '复习备考', 'professor-research': '资料研究', 'professor-latex': '排版文档', 'professor-course-management': '课程整理' }[selector.skill] || '所选任务') + '；保存后新会话会使用。'))) : null
      return h('section', { className: 'professor-home', 'aria-busy': busy },
        h('style', null, PROFESSOR_STYLE),
        h('div', { className: 'professor-home__settings-header' },
          h('h1', null, isSettings ? 'Professor 设置' : data && data.course ? data.course.display_name || data.course.course_code : '课程'),
          ActionButton({ action: 'back-home', label: '返回主页', quiet: true, onClick: props.onBack })),
        view.error ? h('p', { role: 'alert' }, view.error) : null,
        message ? h('p', { role: 'status' }, message) : null,
        isSettings ? h('div', { className: 'professor-home__settings-layout' },
          h('nav', { className: 'professor-home__settings-nav', 'aria-label': 'Professor 设置分区' },
            [['preferences', '学习偏好'], ['workspace', '文件夹与课程'], ['memory', '持久记忆']].map(function (entry) {
              return h('button', { key: entry[0], type: 'button', className: 'professor-home__button',
                'data-professor-section': entry[0], 'aria-pressed': activeSection === entry[0], 'aria-controls': 'professor-panel-' + entry[0],
                onClick: function () { setActiveSection(entry[0]) } }, entry[1])
            })),
          h('div', { className: 'professor-home__settings-content' },
            preferencePanel,
            h('section', { id: 'professor-panel-workspace', hidden: activeSection !== 'workspace', 'aria-label': '文件夹与课程' },
              h(ProfessorWorkspaceSettings, { api: props.api, onConnectionChanging: connectionChanging, onConnectionChanged: connectionChanged })),
            h('section', { id: 'professor-panel-memory', hidden: activeSection !== 'memory', 'aria-label': '持久记忆' },
              h('h2', null, '持久记忆'),
              data ? h('div', null,
                h('p', null, '状态：' + (data.memory.status === 'available' ? data.memory.enabled ? '开启' : '关闭' : '不可用')),
                data.memory.status === 'available' ? ActionButton({ action: 'toggle-memory', label: data.memory.enabled ? '关闭持久记忆' : '开启持久记忆', busy: busy || workspaceBusy, onClick: toggleMemory }) : h('p', { role: 'alert' }, data.memory.message || '记忆存储不可用，请重新读取设置。'),
                h('p', { className: 'professor-home__hint' }, '对所有 Professor 会话生效。关闭暂停记忆读取和写入，不删除已有记忆，也不清空技能定制。'),
                ActionButton({ action: 'refresh-memory', label: '重新读取记忆状态', busy: busy || workspaceBusy, onClick: function () { load(true) } })) : h('p', null, '正在读取设置…')))) : null,
        !data ? h('div', null, busy ? h('p', { role: 'status' }, '正在读取…') : null,
          ActionButton({ action: 'retry-details', label: '重新读取', busy: busy, onClick: load })) : null,
        data && !isSettings ? h('div', null,
          h('p', { className: 'professor-home__hint' }, data.course.course_code + ' · ' + (data.course.term || '未设置学期')),
          h('div', { className: 'professor-home__card-actions' },
            ActionButton({ action: 'study-course', label: '开始学习', primary: true, busy: busy, onClick: function () { study('learn') } }),
            ActionButton({ action: 'ask-course', label: '向 Professor 提问', quiet: true, busy: busy, onClick: function () { study('question') } })),
          h('h2', null, '材料'),
          h('p', { className: 'professor-home__hint' }, '索引状态：' + data.index.status + ' · ' + data.total + ' 项'),
          h('p', { className: 'professor-home__hint' }, '列表是索引记录。点击材料操作时会重新核对原文件；仅添加原生引用，消息由你确认发送。'),
          h('ul', { className: 'professor-home__list' }, data.materials.map(function (row) {
            return h('li', { key: row.fileId, className: 'professor-home__material' },
              h('span', { className: 'professor-home__material-name' }, row.name + ' · ' + row.category),
              h('span', { className: 'professor-home__card-actions' },
                ActionButton({ action: 'study-material-' + row.fileId, label: '学习此材料', quiet: true, busy: busy,
                  onClick: function () { return studyMaterial(row, 'learn') } }),
                ActionButton({ action: 'ask-material-' + row.fileId, label: '就此材料提问', quiet: true, busy: busy,
                  onClick: function () { return studyMaterial(row, 'question') } })))
          })),
          data.nextOffset !== null ? ActionButton({ action: 'more-materials', label: '下一页', busy: busy, onClick: function () {
            setBusy(true)
            props.api.course({ courseId: props.courseId, offset: data.nextOffset }).then(function (next) { setView({ data: next, error: null }) })
              .catch(function (error) { setMessage(messageOf(error)) }).then(function () { setBusy(false) })
          } }) : null,
          h('h2', null, '最近会话'),
          data.historyUnavailable ? h('p', { className: 'professor-home__hint' }, '部分会话无法核实所属项目，已隐藏。') : null,
          h('div', null, data.recent.map(function (row) { return h('div', { key: row.sessionId, className: 'professor-home__row' },
            h('span', { className: 'professor-home__row-title' }, row.title),
            row.status === 'ready' ? ActionButton({ action: 'reopen-course-session', label: '继续', quiet: true, busy: busy, onClick: function () {
              setBusy(true)
              props.api.reopen({ sessionId: row.sessionId }).then(function () { return props.api.open(row.sessionId) })
                .catch(function (error) { setMessage(messageOf(error)) }).then(function () { setBusy(false) })
            } }) : null) }))) : null,
        null)
    }
    /**
     * The Home page.
     *
     * Exactly four things, in reading order: Continue, Start new, Courses, Recent — plus an honest
     * course-free empty state. Loading, error and retry are visible states, never silent fallbacks.
     */
    function ProfessorHome(props) {
      var api = props.api
      var state = React.useState({ status: 'loading', data: null, error: null })
      var view = state[0]
      var setView = state[1]
      var launcher = React.useState({ courseId: '', mode: 'learn', topic: '' })
      var form = launcher[0]
      var setForm = launcher[1]
      var busy = React.useState(null)
      var busyKind = busy[0]
      var setBusy = busy[1]
      var launchRequest = React.useRef(null)
      var navigation = React.useState(null), page = navigation[0], setPage = navigation[1]
      // Deletion is confirmed before anything is sent: `removal` holds the exact target plus the
      // busy/error state of that one confirmation, so a double click cannot start two deletions.
      var removalState = React.useState(null), removal = removalState[0], setRemoval = removalState[1]
      // Clearing a Recent conversation uses the same confirmation pattern, its own sync lock, and
      // the approved semantics: remove from the Professor list, archive the native chat (history
      // stays recoverable in Harness) — never a permanent deletion.
      var clearState = React.useState(null), clearing = clearState[0], setClearing = clearState[1]
      var setupSession = React.useRef({ token: null, sessionId: null })
      var removalPending = React.useRef(false)
      var clearPending = React.useRef(false)

      function load(options) {
        setBusy('refresh')
        return api.home().then(function (data) {
          // `ok: false` is a *reachable* Home whose registry or storage refused: the page still
          // renders, with the reason where the user can act on it.
          setView({ status: 'ready', data: data, error: data.ok === false ? messageOf({ message: data.message, code: data.code }) : null })
          if (options && options.select === true && typeof api.open === 'function' && data.ok === true && !data.continue) {
            // nothing to do: the empty state carries the instruction
          }
        }, function (error) {
          setView({ status: 'error', data: null, error: messageOf(error) })
        }).then(function () { setBusy(null) })
      }

      React.useEffect(function () { load() }, [])

      /** Navigate through the host's own session navigation, after the backend validated the target. */
      function navigate(sessionId) {
        return api.reopen({ sessionId: sessionId }).then(function () {
          return api.open(sessionId)
        }).catch(function (error) {
          setView({ status: 'ready', data: view.data, error: messageOf(error) })
          return null
        })
      }

      function onLaunch(courseId) {
        if (busyKind !== null) return
        setBusy('launch')
        setView({ status: 'ready', data: view.data, error: null })
        var payload = {
          mode: typeof courseId === 'string' ? 'learn' : form.mode,
          courseId: typeof courseId === 'string' ? courseId : form.courseId === '' ? null : form.courseId,
          topic: typeof courseId === 'string' || form.topic.trim() === '' ? null : form.topic.trim(),
        }
        var signature = JSON.stringify(payload)
        if (!launchRequest.current || launchRequest.current.signature !== signature) {
          launchRequest.current = { signature: signature, request: Object.assign({ requestId: newRequestId() }, payload) }
        }
        return api.launch(launchRequest.current.request).then(function (result) {
          return api.open(result.sessionId).then(function () {
            launchRequest.current = null
            return load()
          })
        }).catch(function (error) {
          setView({ status: 'ready', data: view.data, error: messageOf(error) })
          return null
        }).then(function () { setBusy(null) })
      }

      function onReopen(sessionId) {
        if (busyKind !== null) return
        setBusy(sessionId)
        return navigate(sessionId).then(function () { setBusy(null) })
      }

      function onRetry(row) {
        if (busyKind !== null) return
        setBusy(row.sessionId)
        return api.launch({ requestId: row.requestId, mode: row.mode, courseId: row.courseId, topic: null })
          .then(function (result) { return api.open(result.sessionId) })
          .catch(function (error) { setView({ status: 'ready', data: view.data, error: messageOf(error) }) })
          .then(function () { setBusy(null) })
      }

      /**
       * The owned Professor session every guarded workspace command runs through.
       *
       * Home may not have one yet, so it prepares the same kind of internal setup session Settings
       * uses — created against the connected folder, never navigated to, and reused afterwards.
       */
      function ensureSetupSession() {
        if (setupSession.current.sessionId) return Promise.resolve(setupSession.current.sessionId)
        var data = view.data || {}
        var folder = data.connection && data.connection.connected ? data.connection.folder : null
        if (!folder) return Promise.reject(new Error('尚未连接学术文件夹，无法管理课程。'))
        if (!setupSession.current.token) setupSession.current.token = newRequestId()
        var token = setupSession.current.token
        return api.launch({ requestId: token, mode: 'free', courseId: null, topic: '课程设置', folder: folder })
          .then(function (value) {
            setupSession.current = { token: null, sessionId: value.sessionId }
            return value.sessionId
          })
          .catch(function (error) {
            setupSession.current.token = null
            throw error
          })
      }

      function askDeleteCourse(course) {
        if (busyKind !== null || (removal && removal.busy)) return
        setRemoval({ course: course, busy: false, error: null })
      }

      function cancelDeleteCourse() {
        if (removal && removal.busy) return
        setRemoval(null)
      }

      function confirmDeleteCourse() {
        if (!removal || removal.busy || removalPending.current) return
        removalPending.current = true
        var course = removal.course
        setRemoval({ course: course, busy: true, error: null })
        return ensureSetupSession().then(function (sessionId) {
          return api.workspaceCommand({ sessionId: sessionId, action: 'courses', args: {} }).then(function (snapshot) {
            if (!snapshot || !snapshot.courseToken) throw new Error('无法读取课程配置，请刷新后重试。')
            return api.workspaceCommand({ sessionId: sessionId, action: 'manageCourse', args: {
              courseToken: snapshot.courseToken,
              courseId: course.course_id,
              operation: 'delete',
              confirmDelete: true,
            } })
          }).then(function (value) {
            if (!Array.isArray(value.changed) || value.changed.indexOf(course.course_id) === -1 || (value.problems || []).length) {
              throw new Error((value.problems || []).join('；') || '删除未完成，请刷新后重试。')
            }
            setRemoval(null)
            return load()
          })
        }).catch(function (error) {
          // Keep the dialog open on failure so the reason is read where the decision was made.
          setRemoval(function (previous) {
            return previous === null ? null : { course: previous.course, busy: false, error: messageOf(error) }
          })
        }).finally(function () { removalPending.current = false })
      }

      function askClear(row) {
        if (busyKind !== null || (clearing && clearing.busy) || clearPending.current) return
        setClearing({ row: row, busy: false, error: null })
      }

      // Bulk clear: one backend-owned snapshot, one confirmation, then bounded batches. The
      // synchronous ref lock and the server-side single-use token together stop double submission.
      var clearAllState = React.useState(null), clearAll = clearAllState[0], setClearAll = clearAllState[1]
      var clearAllPending = React.useRef(false)

      function askClearAll() {
        if (busyKind !== null || clearAllPending.current || (clearAll && (clearAll.busy || clearAll.phase === 'running'))) return
        setClearAll({ phase: 'loading', busy: true, error: null })
        clearAllPending.current = true
        return api.clearAllSnapshot().then(function (snapshot) {
          setClearAll({ phase: 'confirm', busy: false, error: null, token: snapshot.token, count: snapshot.count, previews: snapshot.previews || [] })
        }).catch(function (error) {
          setClearAll({ phase: 'failed', busy: false, error: messageOf(error) })
        }).finally(function () { clearAllPending.current = false })
      }

      function cancelClearAll() {
        // Cancel performs zero mutation requests: only a local dismissal.
        if (clearAll && (clearAll.busy || clearAll.phase === 'running')) return
        setClearAll(null)
      }

      function runClearAllBatches(state) {
        var counts = null, outcomes = []
        function step(result) {
          counts = result.counts
          outcomes = outcomes.concat(result.outcomes || []).slice(0, 20)
          setClearAll(Object.assign({}, state, {
            phase: 'running', busy: true, counts: counts, outcomes: outcomes,
            error: null,
          }))
          if (result.done) return { counts: counts, outcomes: outcomes }
          return api.clearAllContinue({ operationId: result.operationId }).then(step)
        }
        return api.clearAllStart({ token: state.token }).then(step)
      }

      function confirmClearAll() {
        if (!clearAll || clearAll.busy || clearAll.phase === 'running' || clearAllPending.current) return
        clearAllPending.current = true
        var state = clearAll
        setClearAll(Object.assign({}, state, { phase: 'running', busy: true, counts: null, error: null }))
        return runClearAllBatches(state).then(function (summary) {
          setClearAll({ phase: 'done', busy: false, error: null, counts: summary.counts, outcomes: summary.outcomes })
          return Promise.resolve(api.syncSessions()).then(function () { return load() })
        }).catch(function (error) {
          setClearAll(Object.assign({}, state, { phase: 'failed', busy: false, error: messageOf(error) }))
        }).finally(function () { clearAllPending.current = false })
      }

      function cancelClear() {
        if (clearing && clearing.busy) return
        setClearing(null)
      }

      function confirmClear() {
        // The synchronous ref lock is what stops a double click; the async `busy` state alone would
        // only close the gate after React re-rendered.
        if (!clearing || clearing.busy || clearPending.current) return
        clearPending.current = true
        var row = clearing.row
        setClearing({ row: row, busy: true, error: null })
        return api.clearSession({ sessionId: row.sessionId, confirmed: true })
          .then(function () {
            setClearing(null)
            return load()
          })
          .catch(function (error) {
            // Keep the dialog open on failure so the reason is read where the decision was made,
            // and the confirm button becomes a safe retry.
            setClearing(function (previous) {
              return previous === null ? null : { row: previous.row, busy: false, error: messageOf(error) }
            })
          })
          .finally(function () { clearPending.current = false })
      }

      if (view.status === 'loading') {
        return h('div', { className: 'professor-home', role: 'status', 'aria-busy': 'true' }, '正在载入 Professor…')
      }
      if (view.status === 'error') {
        return h('div', { className: 'professor-home', role: 'alert' },
          h('p', null, view.error),
          ActionButton({ action: 'retry-home', label: '重试', busyLabel: '载入中…', busy: busyKind !== null, onClick: function () { load() } }))
      }

      var data = view.data || {}
      var courses = (data.courses || []).filter(function (course) { return course.active !== false && course.status !== 'archived' })
      var connection = data.connection || { connected: false }
      var recent = data.recent || []
      var continueRow = data.continue || null

      if (page !== null) return h(ProfessorDetails, { key: page.kind + ':' + (page.courseId || ''), page: page.kind,
        courseId: page.courseId, courses: courses, api: api, onBack: function () { setPage(null); load() } })

      return h('div', { className: 'professor-home' },
        h('style', null, PROFESSOR_STYLE),
        h('header', { className: 'professor-home__header' },
          h('h1', { className: 'professor-home__title' }, 'Professor'),
          ActionButton({ action: 'open-settings', label: '设置', onClick: function () { setPage({ kind: 'settings' }) } }),
          ActionButton({ action: 'refresh', label: '刷新', busyLabel: '载入中…', busy: busyKind === 'refresh', onClick: function () { load() } })),
        view.error !== null ? h('p', { className: 'professor-home__error', role: 'alert' }, view.error) : null,

        removal !== null ? h(ConfirmDialog, {
          request: { kind: 'course', action: 'confirm-delete-course',
            name: removal.course.display_name || removal.course.course_code || removal.course.course_id },
          title: '删除这门课程？',
          summary: '将从 Professor 中移除「'
            + (removal.course.display_name || removal.course.course_code || removal.course.course_id)
            + '」的注册信息。',
          points: [
            '这门课不再出现在主页、课程列表和可选课程中，它的检索索引也会被移除。',
            '课程原始文件、笔记、复习资料、学习进度和持久记忆都不会被删除或修改。',
            '其他课程和已有对话不受影响。',
            '之后可以重新扫描并确认同一个文件夹，把这门课加回来。',
          ],
          confirmLabel: '删除课程',
          busy: removal.busy,
          error: removal.error,
          onCancel: cancelDeleteCourse,
          onConfirm: confirmDeleteCourse,
        }) : null,

        clearing !== null ? h(ConfirmDialog, {
          request: { kind: 'conversation', action: 'confirm-clear-conversation',
            name: clearing.row.title },
          title: '清除此对话？',
          summary: '将把「' + clearing.row.title + '」从 Professor 的最近对话和继续学习中移除。',
          points: [
            '对应的 Harness 原生聊天会被归档，而不是永久删除；原生历史在 Harness 中仍然可以恢复。',
            '课程材料、索引、笔记、持久记忆和学习进度都不会改变。',
            '其他对话和课程不受影响。',
            '正在运行的对话需要先结束或由你停止，然后才能清除。',
          ],
          confirmLabel: '清除对话',
          busyLabel: '正在清除…',
          busy: clearing.busy,
          error: clearing.error,
          onCancel: cancelClear,
          onConfirm: confirmClear,
        }) : null,

        clearAll !== null && (clearAll.phase === 'confirm' || clearAll.phase === 'running') ? h(ConfirmDialog, {
          request: { kind: 'clear-all', action: 'confirm-clear-all-conversations', name: clearAll.count + ' 条对话' },
          title: '清除 ' + clearAll.count + ' 条对话？',
          summary: clearAll.phase === 'running'
            ? '正在清除：已清除 ' + ((clearAll.counts && clearAll.counts.cleared) || 0) + ' 条，跳过 ' + ((clearAll.counts && clearAll.counts.skipped) || 0) + ' 条，失败 ' + ((clearAll.counts && clearAll.counts.failed) || 0) + ' 条，剩余 ' + ((clearAll.counts && clearAll.counts.remaining) || 0) + ' 条。'
            : '将清除 Professor 的 ' + clearAll.count + ' 条最近对话（含列表外的历史条目）。',
          points: [
            '对应的 Harness 原生聊天会被归档，而不是永久删除；原生历史在 Harness 中仍然可以恢复。',
            '课程材料、索引、笔记、持久记忆和学习进度都不会改变。',
            '正在运行或仍在准备的对话会跳过并保留，你可以稍后单独清除它们。',
            '确认之后新建的对话不会被包含在这次清除里。',
          ],
          confirmLabel: '清除对话',
          busyLabel: '正在清除…',
          busy: clearAll.phase === 'running',
          error: clearAll.error,
          onCancel: cancelClearAll,
          onConfirm: confirmClearAll,
        }) : null,

        clearAll !== null && clearAll.phase === 'done' ? h('div', { className: 'professor-home__bulk-result', role: 'status' },
          h('p', null, '已清除 ' + clearAll.counts.cleared + ' 条，跳过 ' + clearAll.counts.skipped + ' 条，失败 ' + clearAll.counts.failed + ' 条。'),
          (clearAll.outcomes || []).filter(function (row) { return row.status !== 'cleared' }).slice(0, 5).map(function (row) {
            return h('p', { key: row.sessionId, className: 'professor-home__hint' }, (row.title || row.sessionId) + '：' + row.reason)
          }),
          h('div', { className: 'professor-home__card-actions' },
            ActionButton({ action: 'clear-all-done', label: '完成', onClick: function () { setClearAll(null) } }),
            clearAll.counts.cleared > 0 || clearAll.counts.failed > 0 || clearAll.counts.skipped > 0
              ? ActionButton({ action: 'clear-all-retry', label: '再试剩余', quiet: true, onClick: function () { setClearAll(null); return askClearAll() } })
              : null)) : null,

        clearAll !== null && clearAll.phase === 'failed' ? h('div', { className: 'professor-home__bulk-result', role: 'alert' },
          h('p', null, clearAll.error || '批量清除未完成。'),
          h('div', { className: 'professor-home__card-actions' },
            ActionButton({ action: 'clear-all-retry', label: '重新开始', quiet: true, onClick: function () { setClearAll(null); return askClearAll() } }),
            ActionButton({ action: 'clear-all-dismiss', label: '关闭', onClick: function () { setClearAll(null) } }))) : null,

        continueRow !== null
          ? h('section', { className: 'professor-home__continue' },
            h('div', null,
              h('h2', { className: 'professor-home__heading' }, '继续学习'),
              h('p', { className: 'professor-home__row-title' }, continueRow.title),
              h('p', { className: 'professor-home__row-meta' },
                (MODE_LABELS[continueRow.mode] || continueRow.mode) + ' · ' + shortDate(continueRow.updatedAt))),
            ActionButton({
              primary: true,
              action: 'continue',
              label: '继续',
              busyLabel: '正在打开…',
              busy: busyKind === continueRow.sessionId,
              onClick: function () { onReopen(continueRow.sessionId) },
            }))
          : null,

        Launcher({ state: form, set: function (patch) { setForm(Object.assign({}, form, patch)) }, courses: courses, busy: busyKind !== null, onLaunch: onLaunch }),

        h('section', { className: 'professor-home__section', 'aria-labelledby': 'professor-home-courses' },
          h('h2', { className: 'professor-home__heading', id: 'professor-home-courses' }, '已配置的课程'),
          courses.length === 0
            ? h('p', { className: 'professor-home__empty' },
              connection.connected
                ? '这个学术文件夹里还没有已注册的课程。'
                : '尚未连接学术文件夹。可以直接开始通用学术会话；需要课程材料时，在 Professor 会话里把材料文件夹连接为学术文件夹。')
            : h('ul', { className: 'professor-home__list' }, courses.map(function (course) {
              var courseName = course.display_name || course.course_code || course.course_id
              return h('li', { key: course.course_id, className: 'professor-home__card' },
                h('div', { className: 'professor-home__card-body' },
                  h('span', { className: 'professor-home__card-title' }, courseName),
                  h('span', { className: 'professor-home__row-meta' }, [course.course_code, course.term].filter(Boolean).join(' · '))),
                h('div', { className: 'professor-home__card-actions' },
                  ActionButton({ action: 'course-details', label: '查看课程', quiet: true,
                    onClick: function () { setPage({ kind: 'course', courseId: course.course_id }) } }),
                  ActionButton({ action: 'delete-course-' + course.course_id, label: '删除', quiet: true,
                    labelText: '删除课程 ' + courseName, disabled: busyKind !== null,
                    onClick: function () { askDeleteCourse(course) } }),
                  ActionButton({
                    action: 'use-course',
                    label: '开始学习',
                    primary: true,
                    busy: busyKind === 'launch',
                    disabled: busyKind !== null,
                    onClick: function () { return onLaunch(course.course_id) },
                  })))
            }))),

        Recent({ recent: recent, busyId: busyKind, clearBusyId: clearing !== null && clearing.busy ? clearing.row.sessionId : null,
          clearAllBusy: clearAll !== null && (clearAll.phase === 'loading' || clearAll.phase === 'running'),
          clearAllDisabled: busyKind !== null || clearPending.current,
          onReopen: onReopen, onRetry: onRetry, onClear: askClear, onClearAll: askClearAll }))
    }
    // #endregion

    // #region plugin face
    /** Services this client module needs before `apply` may run. */
    var inject = ['slots', 'layout', 'uiWorkspace', 'remote', 'sessions']

    /** Sidebar icon: a plain inline SVG, so the bundle ships no asset. */
    function ProfessorIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 18 18', role: 'img', 'aria-label': 'Professor', focusable: 'false',
      }, h('path', {
        d: 'M9 2 1.5 6 9 10l7.5-4L9 2Zm0 8.6L1.5 6.6v5.6L9 16.6l7.5-4.4V6.6L9 10.6Z',
        fill: 'currentColor',
      }))
    }

    /**
     * Register Professor Home's UI. Runs on a child context whose only new dependency is the Remote
     * namespace this plugin mounted itself, so every call goes through `homeCtx.remote.professorHome`
     * — the official client projection of the host endpoints — and nothing here touches a transport.
     *
     * @param ctx - the child context handed to the UI fibre.
     * @returns a disposer withdrawing the panel and the sidebar entry.
     */
    function installHome(ctx) {
      var disposers = []
      var handedMaterials = new Set()
      var uiActive = true
      disposers.push(function () { uiActive = false })
      var api = {
        home: function () { return withTimeout(ctx.remote.professorHome.home().then(unwrap), '读取 Professor 主页') },
        launch: function (request) { return withTimeout(ctx.remote.professorHome.launch(request).then(unwrap), '准备会话') },
        reopen: function (request) { return withTimeout(ctx.remote.professorHome.reopen(request).then(unwrap), '打开会话') },
        clearSession: function (request) {
          return withTimeout(ctx.remote.professorHome.clearSession(request).then(unwrap), '清除对话').then(function (value) {
            // After the backend archived and hid the row, refresh the native session list through
            // the supported host API so navigation agrees with the registry. Best-effort: a refresh
            // failure must not report the already-succeeded clear as failed.
            return Promise.resolve(ctx.sessions.refresh()).catch(function () {}).then(function () { return value })
          })
        },
        clearAllSnapshot: function () { return withTimeout(ctx.remote.professorHome.clearAllSnapshot({}).then(unwrap), '获取待清除对话列表') },
        clearAllStart: function (request) { return withTimeout(ctx.remote.professorHome.clearAllStart(request).then(unwrap), '清除对话') },
        clearAllContinue: function (request) { return withTimeout(ctx.remote.professorHome.clearAllContinue(request).then(unwrap), '清除对话') },
        syncSessions: function () { return Promise.resolve(ctx.sessions.refresh()).catch(function () {}) },
        presetLibrary: function (request) { return withTimeout(ctx.remote.professorHome.presetLibrary(request).then(unwrap), '读取学习预设') },
        presetSave: function (request) { return withTimeout(ctx.remote.professorHome.presetSave(request).then(unwrap), '保存学习预设') },
        presetDelete: function (request) { return withTimeout(ctx.remote.professorHome.presetDelete(request).then(unwrap), '删除学习预设') },
        presetApply: function (request) { return withTimeout(ctx.remote.professorHome.presetApply(request).then(unwrap), '使用学习预设') },
        course: function (request) { return withTimeout(ctx.remote.professorHome.course(request).then(unwrap), '读取课程') },
        settings: function (request) { return withTimeout(ctx.remote.professorHome.settings(request).then(unwrap), '读取设置') },
        saveCustomization: function (request) { return withTimeout(ctx.remote.professorHome.saveCustomization(request).then(unwrap), '保存偏好') },
        setMemoryEnabled: function (request) { return withTimeout(ctx.remote.professorHome.setMemoryEnabled(request).then(unwrap), '修改记忆开关') },
        workspaceCommand: function (request) { return withTimeout(ctx.remote.professorHome.workspaceCommand(request).then(unwrap), '学术文件夹操作') },
        pickFolder: function () {
          var desktop = globalThis.__DSH_DIRECTORY_PICKER__
          return desktop && typeof desktop.pick === 'function' ? desktop.pick() : ctx.uiWorkspace.pickDirectory()
        },
        launchMaterial: function (request) { return withTimeout(ctx.remote.professorHome.launchMaterial(request).then(unwrap), '核对课程材料') },
        openMaterial: async function (result, requestId, isCurrent) {
          function current() { return uiActive && (!isCurrent || isCurrent()) }
          if (!current()) throw new Error('Professor 界面已关闭。')
          if (handedMaterials.has(requestId)) {
            await ctx.sessions.refresh()
            if (!current()) throw new Error('材料操作已取消。')
            ctx.uiWorkspace.openSession(result.sessionId); ctx.layout.selectPanel(null); return
          }
          await prepareMaterialDraft(ctx, result, current)
          if (handedMaterials.size >= 100) handedMaterials.delete(handedMaterials.values().next().value)
          handedMaterials.add(requestId)
        },
        /** Official navigation into the native Harness conversation interface. */
        open: async function (sessionId) {
          await withTimeout(ctx.sessions.refresh(), '同步原生会话')
          ctx.uiWorkspace.openSession(sessionId)
          ctx.layout.selectPanel(null)
        },
      }

      function Home() {
        return h(ProfessorHome, { api: api })
      }

      if (typeof ctx.slots.register === 'function') {
        var panel = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          label: 'Professor',
          inject: function () { return { api: api } },
        }, Home)
        if (typeof panel === 'function') disposers.push(panel)
        else disposers.push(function () {})
      }
      if (typeof ctx.slots.inject === 'function') {
        var sidebar = ctx.slots.inject(SIDEBAR_SLOT, function () {
          return ctx.slots.register({
            name: SIDEBAR_SLOT,
            id: PANEL_ID,
            order: 60,
            label: function () { return 'Professor' },
          }, ProfessorIcon)
        })
        if (typeof sidebar === 'function') disposers.push(sidebar)
      }
      disposers.push(function () {
        if (typeof ctx.layout.retirePanel === 'function') ctx.layout.retirePanel(PANEL_ID)
      })

      return async function dispose() {
        uiActive = false
        for (var index = disposers.length - 1; index >= 0; index--) {
          try { await disposers[index]() } catch { /* teardown is best effort, never a throw */ }
        }
      }
    }

    /**
     * Mount Professor Home.
     *
     * Order matters and is observable: the endpoints are mounted **before** anything can be clicked,
     * and everything registered here is withdrawn together in the returned disposer — including the
     * slot contributions and the Remote contribution, which is what "disabling the plugin removes the
     * entry" means on the client.
     *
     * The UI is installed from a **child fibre**, not here. `remote.professorHome` comes into
     * existence when this plugin mounts its own contribution, and a fibre may not both create a
     * service and declare it as a dependency — declaring it here parks the fibre forever (observed:
     * `dsh-professor-spike: pending (waiting for service: remote.professorHome)`). A child created
     * after the mount resolves it immediately and is the only scope allowed to call the endpoints.
     */
    async function apply(ctx) {
      var disposers = []
      try {
        if (typeof ctx.remote.$mount === 'function') {
          disposers.push(await ctx.remote.$mount(TYPERT_REMOTE))
        } else {
          ctx.logger && ctx.logger.warn('professor home: no Remote mount available; Home cannot reach the backend')
          return async function dispose() {}
        }

        var uiFiber = ctx.plugin({ name: PANEL_ID + ':ui', inject: ['remote.professorHome'], apply: installHome })
        await uiFiber
        disposers.push(function () { return uiFiber.dispose() })
      } catch (error) {
        for (var index = disposers.length - 1; index >= 0; index--) {
          try { await disposers[index]() } catch { /* a failed mount must still unwind */ }
        }
        throw error
      }

      return async function dispose() {
        for (var index = disposers.length - 1; index >= 0; index--) {
          try { await disposers[index]() } catch { /* teardown is best effort, never a throw */ }
        }
      }
    }
    // #endregion

    exports.PANEL_ID = PANEL_ID
    Object.defineProperty(exports, 'REMOTE_TIMEOUT_MS', {
      get: function () { return REMOTE_TIMEOUT_MS },
      set: function (value) { if (Number.isFinite(value) && value > 0) REMOTE_TIMEOUT_MS = value },
    })
    exports.STUDY_MODES = STUDY_MODES
    exports.MODE_LABELS = MODE_LABELS
    exports.TYPERT_REMOTE = TYPERT_REMOTE
    exports.ProfessorDetails = ProfessorDetails
    exports.ProfessorWorkspaceSettings = ProfessorWorkspaceSettings
    exports.LearningPresets = LearningPresets
    exports.prepareMaterialDraft = prepareMaterialDraft
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
