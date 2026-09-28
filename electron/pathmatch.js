import path from 'node:path'

/**
 * Pure path helpers shared by the scanner and real-time protection. Kept free
 * of Electron imports so they can be unit tested with plain Node.
 */

/** Normalises a path for comparison: resolved, no trailing separator, lower-case on Windows. */
export function normalizeForMatch(value, platform = process.platform) {
  const impl = platform === 'win32' ? path.win32 : path.posix
  let resolved = impl.resolve(String(value))
  const root = impl.parse(resolved).root
  while (resolved.length > root.length && (resolved.endsWith('\\') || resolved.endsWith('/'))) resolved = resolved.slice(0, -1)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Compiles scan exclusions into a matcher. An exclusion matches the exact
 * file or folder and, for folders, everything beneath it (path-prefix
 * semantics on whole segments, so C:\Temp does not exclude C:\Temporary).
 */
export function createExclusionMatcher(exclusions, platform = process.platform) {
  const sep = platform === 'win32' ? '\\' : '/'
  const entries = (Array.isArray(exclusions) ? exclusions : [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeForMatch(item.trim(), platform))
  if (!entries.length) return () => false
  return (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return false
    const target = normalizeForMatch(candidate, platform)
    return entries.some((entry) => target === entry || target.startsWith(entry.endsWith(sep) ? entry : `${entry}${sep}`))
  }
}
