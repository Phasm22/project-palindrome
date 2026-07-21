import { expect, test } from "bun:test";
import { prettifyRawPfctlText } from "../../src/agent/response-formatter";

test("rewrites quoted raw pfctl rule fragments into the pipe format", () => {
  // Regression: fuzz-campaign F-06 — "What's exposed on proxBig, and what
  // firewall rules are protecting it?" dumped opnsense_readonly's raw pfctl
  // strings verbatim, quoted and pipe-joined on one line, into the final
  // answer instead of a readable summary.
  const raw =
    '- proxBig | rules | "scrub in all fragment reassemble" | "block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any" | "pass in log quick on vtnet0 proto tcp from any to (self) port = ssh flags S/SA keep state"';

  const pretty = prettifyRawPfctlText(raw);

  expect(pretty).toContain("BLOCK | dir=in | if=!vtnet1 | src=192.168.68.0/22 | dst=any");
  expect(pretty).toContain("PASS | dir=in | if=vtnet0 | proto=tcp | src=any | dst=(self) | port=ssh");
  // Non-rule housekeeping directives (no source/destination grammar) pass through untouched.
  expect(pretty).toContain('"scrub in all fragment reassemble"');
  expect(pretty).not.toContain("block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any");
});

test("rewrites bare, unquoted one-per-line raw pfctl rules", () => {
  const raw = [
    "Firewall Rules",
    "- block drop in log inet from 172.16.0.1 to any",
    "- pass in log quick on vtnet0 proto tcp from any to (self) port = ssh flags S/SA keep state",
  ].join("\n");

  const pretty = prettifyRawPfctlText(raw);

  expect(pretty).toContain("- BLOCK | dir=in | src=172.16.0.1 | dst=any");
  expect(pretty).toContain("- PASS | dir=in | if=vtnet0 | proto=tcp | src=any | dst=(self) | port=ssh");
});

test("leaves already-clean, non-pfctl text untouched", () => {
  const clean = "VLAN 50 Switch Ports\n- Gi0/17 | switch=TJswitch | mode=access | provenance=observed";
  expect(prettifyRawPfctlText(clean)).toBe(clean);
});

test("leaves plain English sentences containing 'pass' or 'block' alone", () => {
  const prose = "I'll pass this along, and I won't block the request.";
  expect(prettifyRawPfctlText(prose)).toBe(prose);
});

test("does not rewrite a bare two-word quoted phrase that merely starts with pass/block", () => {
  const text = 'The chef said "pass the salt" and then "block him" from the kitchen.';
  expect(prettifyRawPfctlText(text)).toBe(text);
});

test("rewrites an entire pipe-joined pfctl rule array quoted as a single string, including escaped label quotes", () => {
  // Regression: live re-verification of F-06 surfaced a second bad-output
  // shape beyond the originally-captured one — the model sometimes dumps the
  // *whole* rules array as one giant quoted, pipe-joined blob (with each
  // rule's `label "..."` value left with its JSON-escaped quotes intact)
  // instead of quoting each rule separately. A naive "stop at the first
  // quote" scan would truncate at the first escaped label quote and never
  // reach the actual rule content.
  const raw =
    'exposed_vms | count=0 | firewall_rules="scrub in all fragment reassemble | block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any | block drop in log quick inet6 all label \\"5d75d96ba523ccd456ab15a327c7fed5\\" | pass in log quick on vtnet0 proto tcp from any to (self) port = ssh flags S/SA keep state"';

  const pretty = prettifyRawPfctlText(raw);

  expect(pretty).toContain("BLOCK | dir=in | if=!vtnet1 | src=192.168.68.0/22 | dst=any");
  expect(pretty).toContain("PASS | dir=in | if=vtnet0 | proto=tcp | src=any | dst=(self) | port=ssh");
  // Housekeeping/non-rule segments (scrub directive, bare label-only block) pass through.
  expect(pretty).toContain("scrub in all fragment reassemble");
  expect(pretty).not.toContain("block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any");
  expect(pretty).not.toContain("pass in log quick on vtnet0 proto tcp from any to (self) port = ssh flags S/SA keep state");
});

test("handles empty input", () => {
  expect(prettifyRawPfctlText("")).toBe("");
});
