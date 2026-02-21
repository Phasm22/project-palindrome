import { expect, test } from "bun:test";
import {
  getNextAvailablePalindromeName,
  getRandomPalindromeName,
  isPalindrome,
  PALINDROME_NAMES,
} from "../../src/actions/helpers/palindrome-names";

test("random generated VM name is from palindrome catalog", () => {
  const generated = getRandomPalindromeName();
  expect(PALINDROME_NAMES.includes(generated as any)).toBe(true);
  expect(isPalindrome(generated)).toBe(true);
});

test("next available generated VM name avoids existing names and remains palindrome", () => {
  const generated = getNextAvailablePalindromeName(["aha", "bob", "civic"]);
  expect(["aha", "bob", "civic"]).not.toContain(generated);
  expect(isPalindrome(generated)).toBe(true);
});

