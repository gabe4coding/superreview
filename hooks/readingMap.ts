// Deterministic on purpose: no model chooses where the human looks.

const TEST = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|Tests?\.(java|kt|cs|swift)$|(^|\/)test_[^/]+\.py$/
const CONFIG = /\.(ya?ml|toml|ini|properties|conf|env)$|(^|\/)(Dockerfile|docker-compose[^/]*|Makefile)$|(^|\/)(\.github|helm|k8s|charts|terraform|deploy)\/|(^|\/)(package|tsconfig|composer)\.json$|\.tf$/
const MIGRATION = /migrat|flyway|liquibase|alembic|(^|\/)db\/changelog\/|\.sql$/i
const PUBLIC_API = /openapi|swagger|\.proto$|\.graphqls?$|\.avsc$|(^|\/)(api|contracts?|schemas?)\/|controller|\.d\.ts$|(^|\/)index\.(ts|js)$/i
const ERROR_HANDLING = /\b(catch|throw|throws|raise|except|rescue|panic|recover|finally)\b|\.catch\(|\btry\s*[:{]|\bErr\(|\berrors?\.New\b/

const MAX_FILES = 6

export type FileChange = { status: string; path: string; added: number; removed: number }

export function parseChanges(nameStatus: string, numstat: string): FileChange[] {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const line of numstat.split('\n')) {
    const [a, r, ...rest] = line.split('\t')
    if (a === undefined || r === undefined || rest.length === 0) continue
    const path = rest[rest.length - 1]!.replace(/^.*=> /, '').replace(/[{}]/g, '')
    counts.set(path, { added: Number(a) || 0, removed: Number(r) || 0 })
  }

  return nameStatus
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(line => {
      const parts = line.split('\t')
      const status = parts[0]!.charAt(0)
      const path = parts[parts.length - 1]!
      const c = counts.get(path) ?? { added: 0, removed: 0 }

      return { status, path, ...c }
    })
}

export function errorHandlingHits(diff: string): Map<string, number> {
  const hits = new Map<string, number>()
  let file = ''
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (header) {
      file = header[1]!
      continue
    }
    if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) continue
    if (ERROR_HANDLING.test(line.slice(1))) hits.set(file, (hits.get(file) ?? 0) + 1)
  }

  return hits
}

const list = (paths: string[]) => {
  const shown = paths.slice(0, MAX_FILES).map(p => `\`${p}\``).join(', ')
  const more = paths.length - MAX_FILES

  return more > 0 ? `${shown} and ${more} more` : shown
}

export function readingMap(changes: FileChange[], diff: string): string[] {
  const lines: string[] = []
  const paths = (f: (c: FileChange) => boolean) => changes.filter(f).map(c => c.path)

  const testsDeleted = paths(c => c.status === 'D' && TEST.test(c.path))
  const testsChanged = paths(c => c.status !== 'D' && TEST.test(c.path))
  const migrations = paths(c => MIGRATION.test(c.path))
  const publicApi = paths(c => !TEST.test(c.path) && PUBLIC_API.test(c.path))
  const config = paths(c => !MIGRATION.test(c.path) && CONFIG.test(c.path))
  const deleted = paths(c => c.status === 'D' && !TEST.test(c.path))
  const errors = [...errorHandlingHits(diff)]
    .filter(([p]) => !TEST.test(p))
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} (${n})`)

  if (testsDeleted.length) lines.push(`**Tests deleted:** ${list(testsDeleted)}`)
  if (migrations.length) lines.push(`**Migrations:** ${list(migrations)}`)
  if (publicApi.length) lines.push(`**Public API / contracts:** ${list(publicApi)}`)
  if (config.length) lines.push(`**Config:** ${list(config)}`)
  if (errors.length) lines.push(`**Error handling changed:** ${list(errors)}`)
  if (deleted.length) lines.push(`**Files deleted:** ${list(deleted)}`)
  lines.push(
    testsChanged.length
      ? `**Tests changed:** ${list(testsChanged)}`
      : '**Tests changed:** none',
  )

  const added = changes.reduce((n, c) => n + c.added, 0)
  const removed = changes.reduce((n, c) => n + c.removed, 0)
  lines.push(`**Size:** ${changes.length} files, +${added} −${removed}`)

  return lines
}
