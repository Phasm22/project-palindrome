const MIN_PLAUSIBLE_VM_NAME_LENGTH = 3;
const PLAUSIBLE_VM_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Guards against passing garbled, adversarial, or otherwise-implausible
 * "VM name" strings into fuzzy twin/cluster lookups.
 *
 * Real VM/hostnames in this infra are always short, single-token
 * identifiers (letters, digits, dots, dashes, underscores). A free-text
 * fragment left over from prompt-injection-style input (e.g. a stray
 * character captured right after a verb like "delete" in a Cypher/SQL
 * payload) or a multi-word sentence passed through verbatim is not a real
 * identifier. Treating it as "resolved" lets fuzzy substring matching in
 * the twin/cluster lookup silently pick an unrelated real VM as the
 * target. Callers should fail closed (ask for clarification / return
 * "not found") instead of proceeding once this returns false.
 */
export function isPlausibleVmIdentifier(candidate: string): boolean {
  const trimmed = candidate.trim();
  return trimmed.length >= MIN_PLAUSIBLE_VM_NAME_LENGTH && PLAUSIBLE_VM_NAME_PATTERN.test(trimmed);
}
