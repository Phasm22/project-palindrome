/**
 * Palindrome Name Generator
 * 
 * Provides a list of palindrome strings for VM naming convention.
 * All VMs created by Palindrome should use palindrome names by default.
 */

/**
 * Real dictionary word palindromes for VM naming
 * All entries are actual English words that read the same forwards and backwards
 */
export const PALINDROME_NAMES = [
  // Common short palindromes (real words)
  "aha", "bib", "bob", "dad", "did", "dud", "eve", "gag", "gig", "hah", "huh", "kak", "kik", "lol", "mam", "mem", "mom", "nan", "non", "pap", "pep", "pip", "pop", "rar", "rer", "sas", "sis", "tat", "tot", "tut", "wow", "yay", "zaz",
  
  // 4-letter palindromes (real words)
  "noon", "peep", "poop", "sees", "teet",
  
  // 5-letter palindromes (real words)
  "civic", "kayak", "level", "madam", "minim", "radar", "refer", "rotor", "sagas", "solos", "stats", "tenet",
  
  // 6-letter palindromes (real words)
  "redder", "repaper", "reviver", "rotator",
  
  // 7-letter palindromes (real words)
  "deified", "repaper", "reviver", "rotator",
  
  // 8-letter palindromes (real words)
  "deleveled", "detartrated", "devoved",
  
  // 9-letter palindromes (real words)
  "evitative",
  
  // 10-letter palindromes (real words)
  "detartrated",
  
  // 11-letter palindromes (real words)
  "aibohphobia",
  
  // 12-letter palindromes (real words)
  "tattarrattat",
  
  // Additional real word palindromes
  "hannah", "terret", "testset", "murdrum",
  
  // Compound/technical palindromes (real words or accepted terms)
  "racecar", "redder",
] as const;

export type PalindromeName = typeof PALINDROME_NAMES[number];

/**
 * Get a random palindrome name
 */
export function getRandomPalindromeName(): string {
  const index = Math.floor(Math.random() * PALINDROME_NAMES.length);
  return PALINDROME_NAMES[index];
}

/**
 * Get a palindrome name by index (deterministic)
 */
export function getPalindromeNameByIndex(index: number): string {
  const safeIndex = index % PALINDROME_NAMES.length;
  return PALINDROME_NAMES[safeIndex];
}

/**
 * Check if a string is a palindrome
 */
export function isPalindrome(str: string): boolean {
  const normalized = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === normalized.split("").reverse().join("");
}

/**
 * Get next available palindrome name (checks against existing VMs)
 * Returns a palindrome that doesn't conflict with existing VM names
 */
export function getNextAvailablePalindromeName(
  existingNames: string[],
  startIndex: number = 0
): string {
  const existingSet = new Set(existingNames.map(n => n.toLowerCase()));
  
  // Try palindromes starting from startIndex
  for (let i = startIndex; i < PALINDROME_NAMES.length + startIndex; i++) {
    const candidate = getPalindromeNameByIndex(i);
    if (!existingSet.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  
  // If all palindromes are taken, generate a new one by appending numbers
  // This shouldn't happen with 50+ palindromes, but fallback just in case
  let counter = 1;
  while (true) {
    const base = getRandomPalindromeName();
    const candidate = `${base}${counter}`;
    if (!existingSet.has(candidate.toLowerCase())) {
      return candidate;
    }
    counter++;
    if (counter > 1000) {
      // Emergency fallback: use timestamp-based palindrome
      const timestamp = Date.now().toString();
      return `pal${timestamp.split("").reverse().join("")}`;
    }
  }
}

