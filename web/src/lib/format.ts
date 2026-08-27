/**
 * Ward names come from source datasets with inconsistent casing (some
 * ALL-CAPS DMC records, some already title-cased) — flows straight through
 * to the UI unnormalized, producing "SONIA VIHAR" next to "Rohini" in the
 * same list. If a name already mixes upper and lower case, assume it's
 * already well-formatted and leave it alone; otherwise re-case it.
 */
export function formatWardName(name: string): string {
  if (!name) return name
  if (/[a-z]/.test(name) && /[A-Z]/.test(name)) return name
  return name
    .toLowerCase()
    .split(' ')
    .map((word) =>
      word
        .split('.')
        .map((seg) => seg.replace(/[a-z]/, (c) => c.toUpperCase()))
        .join('.'),
    )
    .join(' ')
}
