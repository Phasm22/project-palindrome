/**
 * Helpers for identity and meta-query detection (name update, name query, assistant name).
 */

function normalizeUserName(rawName: string): string {
  const trimmed = rawName.trim().replace(/[.!?]+$/, "");
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (!collapsed) return "";
  const unquoted = collapsed.replace(/^["'](.+)["']$/, "$1");
  const isAllLower = unquoted === unquoted.toLowerCase();
  const isAllUpper = unquoted === unquoted.toUpperCase();
  if (isAllLower || isAllUpper) {
    return unquoted
      .split(" ")
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
      .join(" ");
  }
  return unquoted;
}

export function extractUserNameUpdate(input: string): string | null {
  const patterns = [
    /^\s*my name is\s+(.+)\s*$/i,
    /^\s*call me\s+(.+)\s*$/i,
    /^\s*you can call me\s+(.+)\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match) continue;
    const candidate = normalizeUserName(match[1] ?? "");
    if (!candidate || candidate.length > 60) return null;
    const lower = candidate.toLowerCase();
    const stopPhrases = [" and ", " but ", " also ", " plus ", " because ", " then ", " please "];
    if (stopPhrases.some((phrase) => lower.includes(phrase))) return null;
    return candidate;
  }
  return null;
}

export function isUserNameQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    /^(what('?s| is) my name)\??$/.test(normalized) ||
    /^(do you know my name)\??$/.test(normalized) ||
    /^(tell me my name)\??$/.test(normalized)
  );
}

export function isAssistantNameQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    /^(what('?s| is) your name)\??$/.test(normalized) ||
    /^(who are you)\??$/.test(normalized)
  );
}

export function isMetaIdentityQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (isUserNameQuery(normalized) || isAssistantNameQuery(normalized)) return true;
  return /^(what do you do|what can you do)\??$/.test(normalized);
}

export function isLivenessCheck(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return /^(?:test|ping|health\s*check|are you (?:online|alive|up))[.!?]*$/.test(normalized);
}
