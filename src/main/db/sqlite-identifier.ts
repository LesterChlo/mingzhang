/** SQLite identifier equality folds ASCII A-Z only; Unicode content stays exact. */
export function foldSqliteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32))
}
