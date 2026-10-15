/** Keep startup alive only until its bounded deadline, then report the failed host rows. */
export async function activationDeadline(operation, options = {}) {
  const { timeoutMs = 20_000, diagnostic = async () => 'check host services and local listener permissions' } = options
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve().then(diagnostic).then(
        (detail) => reject(new Error(`Harness activation timed out after ${timeoutMs}ms: ${detail}`)),
        (error) => reject(new Error(`Harness activation timed out after ${timeoutMs}ms; diagnostics failed: ${error.message}`)),
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Read only activation error messages, never configuration or credentials. */
export async function hostActivationDiagnostic(ctx) {
  const lines = []
  for (const entry of ctx?.get('loader')?.entries() ?? []) {
    const fiber = entry.fiber
    if (entry.disabled || fiber === undefined || fiber.state === 2) continue
    if (fiber.state === 3) {
      try { await fiber.await() }
      catch (error) { lines.push(`${entry.id}: ${error.message}`) }
    } else {
      lines.push(`${entry.id}: activation pending`)
    }
  }
  return lines.join('; ') || 'host did not settle; check local listener permissions'
}
