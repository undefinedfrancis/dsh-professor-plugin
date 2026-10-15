/** Accept stable and prerelease SemVer, including optional build identifiers. */
export function isReleaseVersion(value) {
  if (typeof value !== 'string') return false
  const number = '(?:0|[1-9][0-9]*)'
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  return new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(value)
}
