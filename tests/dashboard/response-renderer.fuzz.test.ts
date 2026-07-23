import { describe, expect, test } from "bun:test";
import { renderRawTextFallback } from "../../dashboard/js/response-renderer.js";

/**
 * Fuzz coverage for the chat/reasoning-trace text formatter. Every real bug
 * fixed in this formatter so far (raw pipes leaking through, comma-crammed
 * cells, bare-value tuples, bulleted entity rows, fenced code after prose)
 * came from a *new* real-world response shape the LLM produced that nobody
 * had thought to test. This file tries to generate that variety up front
 * instead of waiting for the next screenshot.
 *
 * Invariants checked on every case (random and fixed):
 *  1. renderRawTextFallback never throws.
 *  2. No raw " | " leaks into rendered prose/list/table text (outside a
 *     <pre> block, where literal pipes in ASCII-art tables are expected).
 *  3. HTML-unsafe input characters never appear unescaped (XSS safety).
 *  4. Non-blank input never renders to nothing.
 */

// Deterministic PRNG (mulberry32) so a failure is reproducible from the seed.
function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260722;
const rand = mulberry32(SEED);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const PLAIN_WORDS = ["homebridge", "opsbox", "YANG", "yin", "proxBig", "running", "stopped", "online", "LXC", "QEMU"];
const NUMERIC_PHRASES = ["93.93GB total (51.29GB used)", "CPU 0.21", "Load Avg 0.69", "Uptime 60+ days", "8006", "172.16.0.0/22", "0.21", "15.52GB"];
const NESTED_PAREN_PHRASES = ["5 VMs (2 QEMU, 3 LXC)", "opsbox (VMID 211, 2 QEMU, 1 LXC)", "((nested, deeply), (again, here))"];
const KV_PHRASES = ["Status=running", "Node=YANG", "cpu: 0.21", "memory: 15.52GB", "port=8006", "vlan:40"];
const WEIRD_PHRASES = [
  "", " ", "   ", "---", "|", "||", "a,b,c,,d", "<script>alert(1)</script>", "5 > 3 & 2 < 4",
  "emoji 🔥📦✅", "quote \"nested\" 'value'", "back\\slash", "a".repeat(400), "line1\r\nline2\r\n",
  "(((a, b), c), d)", "多字节字符测试", "null", "undefined", "NaN", "-0",
];

function randomCell(): string {
  const kind = pick(["plain", "numeric", "nested", "kv", "weird"]);
  if (kind === "plain") return pick(PLAIN_WORDS);
  if (kind === "numeric") return pick(NUMERIC_PHRASES);
  if (kind === "nested") return pick(NESTED_PAREN_PHRASES);
  if (kind === "kv") return pick(KV_PHRASES);
  return pick(WEIRD_PHRASES);
}

function randomPipeLine(cols: number): string {
  return Array.from({ length: cols }, () => randomCell()).join(" | ");
}

function randomTableBlock(): string {
  const cols = int(1, 6);
  const rows = int(0, 4);
  const lines = [randomPipeLine(cols)];
  for (let r = 0; r < rows; r++) {
    // Occasionally go ragged (different column count) to hit the ASCII fallback.
    const rowCols = rand() < 0.15 ? int(1, 6) : cols;
    lines.push(randomPipeLine(rowCols));
  }
  return lines.join("\n");
}

function randomBulletBlock(): string {
  const marker = pick(["-", "*"]);
  const n = int(1, 5);
  return Array.from({ length: n }, () => `${marker} ${randomCell()}`).join("\n");
}

function randomNumberedBlock(): string {
  const n = int(1, 5);
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${randomCell()}`).join("\n");
}

function randomCodeBlock(): string {
  const lang = pick(["", "bash", "json", "yaml"]);
  const body = pick(["echo hi", "{\"a\": 1, \"b\": 2}", "a | b | c", "GET /api/health"]);
  return "```" + lang + "\n" + body + "\n```";
}

function randomProseBlock(): string {
  return `${pick(PLAIN_WORDS)} is ${pick(["running", "stopped", "unreachable"])} on ${pick(PLAIN_WORDS)}.`;
}

function randomBlock(): string {
  const kind = pick(["table", "bullets", "numbered", "code", "prose"]);
  if (kind === "table") return randomTableBlock();
  if (kind === "bullets") return randomBulletBlock();
  if (kind === "numbered") return randomNumberedBlock();
  if (kind === "code") return randomCodeBlock();
  return randomProseBlock();
}

function randomResponse(): string {
  const blocks = int(1, 4);
  return Array.from({ length: blocks }, () => randomBlock()).join("\n\n");
}

/** Strips <pre>...</pre> (ASCII tables / code blocks legitimately contain literal pipes). */
function stripPreBlocks(html: string): string {
  return html.replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, "");
}

describe("response-renderer fuzz coverage", () => {
  const CASES = 300;
  const failures: Array<{ index: number; input: string; error: string }> = [];

  for (let i = 0; i < CASES; i++) {
    const input = randomResponse();
    try {
      const html = renderRawTextFallback(input);
      const outsidePre = stripPreBlocks(html);

      if (outsidePre.includes(" | ")) {
        failures.push({ index: i, input, error: `raw " | " leaked outside <pre>: ${outsidePre.slice(0, 200)}` });
        continue;
      }
      if (input.includes("<script>") && html.includes("<script>")) {
        failures.push({ index: i, input, error: "unescaped <script> in output" });
        continue;
      }
      if (input.trim() && !html.trim()) {
        failures.push({ index: i, input, error: "non-blank input rendered to nothing" });
      }
    } catch (err) {
      failures.push({ index: i, input, error: String(err) });
    }
  }

  test(`${CASES} randomly generated response shapes (seed ${SEED}) never leak raw pipes, never throw, never drop non-blank content`, () => {
    if (failures.length > 0) {
      const report = failures
        .slice(0, 5)
        .map((f) => `  [case ${f.index}] ${f.error}\n    input: ${JSON.stringify(f.input.slice(0, 300))}`)
        .join("\n");
      throw new Error(`${failures.length}/${CASES} fuzz cases failed (showing up to 5):\n${report}`);
    }
    expect(failures.length).toBe(0);
  });
});

describe("response-renderer fixed edge cases", () => {
  const EDGE_CASES: Array<{ name: string; input: string }> = [
    { name: "empty string", input: "" },
    { name: "whitespace only", input: "   \n\t  " },
    { name: "single pipe character", input: "|" },
    { name: "double pipe", input: "||" },
    { name: "markdown table with separator row", input: "| Name | Status |\n| --- | --- |\n| homebridge | running |" },
    { name: "CRLF line endings", input: "a | b | c\r\nd | e | f\r\n" },
    { name: "leading/trailing blank lines", input: "\n\n\nsome text\n\n\n" },
    { name: "extremely long single cell", input: `label | ${"x".repeat(2000)}` },
    { name: "deeply nested parens with commas", input: "field | (((a, b), c), d)" },
    { name: "many sequential commas", input: "a,,,b" },
    { name: "HTML injection attempt in cell", input: "name | <img src=x onerror=alert(1)>" },
    { name: "script tag as bare text", input: "<script>alert('x')</script>" },
    { name: "ampersand and angle brackets in prose", input: "5 > 3 & 2 < 4, still fine" },
    { name: "unicode/emoji heavy", input: "status | running ✅ 🔥 | node | YANG 数据" },
    { name: "mixed table + bullets + code in one response", input: "Summary | Value\nA | B\n\n- point one\n- point two\n\n```bash\necho done\n```" },
    { name: "fenced code containing pipes", input: "```\na | b | c\n```" },
    { name: "single bulleted entity with many key=value fields", input: "- homebridge | Status=running | Node=YANG | Type=LXC | Uptime=60d | CPU=0.1" },
    { name: "bare tuple with 6 unlabeled values", input: "a | b | c | d | e | f" },
    { name: "backtick inside pipe cell", input: "cmd | `ls -la`" },
    { name: "trailing pipe on line", input: "a | b |" },
    { name: "leading pipe on line", input: "| a | b" },
  ];

  for (const { name, input } of EDGE_CASES) {
    test(`handles: ${name}`, () => {
      let html = "";
      expect(() => {
        html = renderRawTextFallback(input);
      }).not.toThrow();

      const outsidePre = stripPreBlocks(html);
      expect(outsidePre.includes(" | ")).toBe(false);

      // XSS safety means the dangerous delimiters (< >) are escaped, not
      // that the substring "onerror=" never appears — it's harmless once
      // it can no longer form a real tag, e.g. "&lt;img ...onerror=...&gt;".
      if (input.includes("<script>") || input.includes("<img")) {
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<img");
      }

      if (input.trim()) {
        expect(html.trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe("response-renderer real-world corpus regressions", () => {
  // Captured verbatim from a live agent run during the 2026-07-21 fuzz
  // campaign (query: "Give me a full security posture summary: exposed
  // VMs, open firewall rules, and DNS records."). A bare bullet header
  // ("- **Exposed VMs:**") was swallowing the *following* bold-labeled,
  // pipe-delimited data bullets ("- **VmName:** X | **VmId:** Y | ...")
  // as literal <li> text, because the bullet-gathering loop didn't stop
  // at a pipe the way the paragraph loop and the pipe-entry check did.
  test("bold-labeled pipe bullets nested under a plain bullet header don't leak pipes", () => {
    const response =
      "**Security Posture Summary:**\n\n- **Exposed VMs:**\n" +
      "  - **VmName:** PvVPN-Home | **VmId:** compute-vm:yang:103 | **Subnets:** 192.168.71.40/22\n" +
      "  - **VmName:** opnsense | **VmId:** compute-vm:proxbig:101 | **Subnets:** 172.16.0.1/22, 10.10.31.1/24, 192.168.71.5/22\n" +
      "  - **VmName:** opsbox | **VmId:** compute-vm:yang:211 | **Subnets:** 172.16.0.184/22\n\n" +
      "- **Open Firewall Rules:**\n" +
      "  - **Action:** block | **Direction:** in | **Source:** 192.168.71.5 | **Destination:** any\n" +
      "  - **General Block Rules:** Many rules blocking incoming traffic from various sources to any destination.\n\n" +
      "- **DNS Records:**\n" +
      "  - Current DNS records were not retrieved from the query.\n\n" +
      "This summary gives an overview of exposed VMs, notable firewall rules, and a note on DNS records availability.";

    const html = renderRawTextFallback(response);
    const outsidePre = stripPreBlocks(html);
    expect(outsidePre.includes(" | ")).toBe(false);
    expect(html).toContain("PvVPN-Home");
    expect(html).toContain("compute-vm:yang:103");
    // The plain bullet headers with no pipe still render as ordinary list items.
    expect(html).toContain("DNS Records");
  });

  // Captured verbatim from a live agent run (query: "List all firewall
  // rules for the WAN interface."). Real OPNsense rule dumps are bulleted
  // "entity | key=value | ..." rows with wildly varying field counts row
  // to row (2 to 5 fields) — a large, ragged, real-world stress case.
  test("a long ragged-arity bulleted rule dump renders without leaking pipes or crashing", () => {
    const response =
      "Firewall Rules\n" +
      "- BLOCK | dir=in | src=192.168.71.5 | dst=any\n" +
      "- BLOCK | dir=in\n" +
      "- BLOCK | dir=in | proto=tcp | src=any\n" +
      "- PASS | dir=out\n" +
      "- PASS | dir=in | if=vlan01 | src=any | dst=172.16.0.0/22\n" +
      "- PASS | dir=out | if=vtnet0 | proto=tcp | src=(vtnet0:network) | dst=(vtnet1:network)\n" +
      "- BLOCK | dir=in | if=vtnet1 | src=<blocked_countries> | dst=any\n" +
      "- PASS | dir=in | if=wireguard | src=<WG_VIP> | dst=(vtnet0:network)\n\n" +
      "Alias definitions:\n" +
      "WG_VIP = 10.16.0.0/29\n" +
      "blocked_countries = CN, RU";

    let html = "";
    expect(() => {
      html = renderRawTextFallback(response);
    }).not.toThrow();
    const outsidePre = stripPreBlocks(html);
    expect(outsidePre.includes(" | ")).toBe(false);
    expect(html).toContain("BLOCK");
    expect(html).toContain("blocked_countries");
  });

  // Captured verbatim (query: "What's on subnet 172.16.0.0/22?"). The
  // clean, common-case shape: consistent 3-field bulleted entity rows —
  // confirms this still renders as a proper table, not just "doesn't leak".
  test("clean consistent bulleted entity rows still render as a real table", () => {
    const response =
      "VMs on subnet 172.16.0.0/22\n" +
      "- opnsense | VMID=101 | node=proxBig\n" +
      "- opsbox | VMID=211 | node=YANG\n" +
      "- sentinelZero | VMID=200 | node=yin\n" +
      "- windowsVM | VMID=100 | node=proxBig";

    const html = renderRawTextFallback(response);
    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain("<th>VMID</th>");
    expect(html).toContain("<th>node</th>");
    expect(html).toContain(">opsbox<");
    expect(html.includes(" | ")).toBe(false);
  });
});
