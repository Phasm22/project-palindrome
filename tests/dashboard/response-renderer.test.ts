import { describe, expect, test } from "bun:test";
import {
  renderAdaptiveValue,
  renderAssistantResponse,
  renderConnectionEndpoints,
  renderRawTextFallback,
} from "../../dashboard/js/response-renderer.js";

describe("adaptive response renderer", () => {
  test("renders verified connection cards with copyable commands", () => {
    const html = renderConnectionEndpoints([{
      service: "SSH",
      protocol: "ssh",
      addressType: "dns",
      port: 22,
      value: "ssh -p 22 ops@vm.prox",
      status: "verified",
      detail: "Authenticated SSH check passed",
    }]);
    expect(html).toContain("connection-card-verified");
    expect(html).toContain("ssh -p 22 ops@vm.prox");
    expect(html).toContain("data-copyable");
    expect(html).toContain("Authenticated SSH check passed");
  });

  test("renders homogeneous records as a table without a domain schema", () => {
    const html = renderAdaptiveValue([
      { name: "node-a", online: true, guests: 4 },
      { name: "node-b", online: false, guests: 2 },
    ]);

    expect(html).toContain("response-table");
    expect(html).toContain("node-a");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
  });

  test("renders nested and heterogeneous values without dropping data", () => {
    const html = renderAdaptiveValue({
      nullable: null,
      nested: { address: "10.0.0.2", tags: ["prod", { owner: "ops" }] },
    });

    expect(html).toContain("nullable");
    expect(html).toContain("None");
    expect(html).toContain("10.0.0.2");
    expect(html).toContain("owner");
    expect(html).toContain("ops");
  });

  test("escapes untrusted values and styles balanced backticks as inline code", () => {
    const html = renderRawTextFallback("Use `host-a` <script>alert(1)</script>");

    expect(html).toContain('<code class="response-inline-code">host-a</code>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("styles aliases without requiring an alias-specific renderer", () => {
    const html = renderAssistantResponse({
      structuredResponse: {
        version: "2",
        answer: {
          summary: "Alias `TJs_Computers` contains `TJ_surface` and `SentinelZero_local`.",
          sections: [],
        },
      },
    });

    expect(html.match(/response-inline-code/g)).toHaveLength(3);
    expect(html).toContain(">TJs_Computers</code>");
  });

  test("leaves unmatched backticks literal", () => {
    const html = renderRawTextFallback("unfinished `value");
    expect(html).toContain("unfinished `value");
    expect(html).not.toContain("<code");
  });

  test("renders TERSE_DATA header+row pipe text as a real table, not raw pipes", () => {
    const html = renderRawTextFallback(
      "VM_COUNT | STORAGE_SUMMARY | HEALTH\n" +
      "5 VMs (2 QEMU, 3 LXC) | local: 93.93GB total (51.29GB used) | CPU 0.21, Uptime 60+ days"
    );

    expect(html).toContain("response-table");
    expect(html).toContain("<th>VM_COUNT</th>");
    expect(html).toContain("<th>STORAGE_SUMMARY</th>");
    expect(html).toContain("5 VMs (2 QEMU, 3 LXC)");
    expect(html).not.toContain(" | ");
  });

  test("renders a bare unlabeled pipe row as compact chips, not a bullet list or raw pipes", () => {
    const html = renderRawTextFallback("piholelab | running | yin");

    expect(html).toContain("response-value-chips");
    expect(html).toContain('<span class="response-value-chip">piholelab</span>');
    expect(html).toContain('<span class="response-value-chip">running</span>');
    expect(html).toContain('<span class="response-value-chip">yin</span>');
    expect(html).not.toContain("<ul");
    expect(html).not.toContain(" | ");
  });

  test("renders a bulleted 'entity | key=value | ...' line (TERSE_DATA single-entity convention) as a table", () => {
    const html = renderRawTextFallback(
      "Homebridge Status\n- homebridge | Status=running | Node=YANG | Type=LXC container"
    );

    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("<th>Node</th>");
    expect(html).toContain(">homebridge<");
    expect(html).toContain(">running<");
    expect(html).toContain(">YANG<");
    expect(html).not.toContain("- homebridge");
  });

  test("renders multiple bulleted entity rows sharing keys as one multi-row table", () => {
    const html = renderRawTextFallback(
      "- homebridge | Status=running | Node=YANG\n- plex | Status=stopped | Node=YIN"
    );

    const rowCount = (html.match(/<tr>/g) ?? []).length;
    expect(rowCount).toBe(3); // header + 2 entity rows
    expect(html).toContain(">homebridge<");
    expect(html).toContain(">plex<");
  });

  test("renders fenced code blocks even after a preceding prose line", () => {
    const html = renderRawTextFallback("Run this:\n```bash\necho hi\n```");

    expect(html).toContain('<pre class="response-code-block"><code>echo hi</code></pre>');
    expect(html).not.toContain("```");
  });

  test("splits comma-separated table cell content onto separate lines", () => {
    const html = renderRawTextFallback(
      "STORAGE_SUMMARY | HEALTH\n" +
      "local: 93.93GB total (51.29GB used), local-lvm: 348.82GB total (47.19GB used) | CPU 0.21, Memory 15.52GB total, Uptime 60+ days"
    );

    const cellLines = html.match(/response-table-cell-line/g) ?? [];
    expect(cellLines.length).toBe(5); // 2 storage entries + 3 health entries
    expect(html).toContain(">local: 93.93GB total (51.29GB used)<");
    expect(html).toContain(">local-lvm: 348.82GB total (47.19GB used)<");
  });

  test("does not split a table cell on a comma nested inside parentheses", () => {
    const html = renderRawTextFallback(
      "VM_COUNT | HEALTH\n" +
      "5 VMs (2 QEMU, 3 LXC) | CPU 0.21"
    );

    expect(html).not.toContain("response-table-cell-line");
    expect(html).toContain(">5 VMs (2 QEMU, 3 LXC)<");
  });

  test("renders a single pipe-delimited key=value line as facts", () => {
    const html = renderRawTextFallback("cpu: 0.21 | memory: 15.52GB | uptime: 60+ days");

    expect(html).toContain("response-facts");
    expect(html).toContain("<dt>cpu</dt>");
    expect(html).toContain("<dd>0.21</dd>");
  });

  test("falls back to an aligned ASCII table when pipe rows have inconsistent column counts", () => {
    const html = renderRawTextFallback(
      "node-a | 4 CPU | 16GB | online\n" +
      "node-b | 8 CPU | online\n" +
      "node-c | 2 CPU | 8GB | 90 days | online"
    );

    expect(html).toContain("response-ascii-table");
    expect(html).toContain("node-a");
    expect(html).toContain("+--------+"); // plain-ASCII border, not Unicode box-drawing
  });

  test("renders markdown-style bullets as a real list", () => {
    const html = renderRawTextFallback("Direct answer.\n- first point\n- second point");

    expect(html).toContain("<ul class=\"response-list\">");
    expect(html).toContain("<li>first point</li>");
  });

  test("uses the same entrypoint for structured and raw messages", () => {
    const structured = renderAssistantResponse({
      structuredResponse: {
        version: "2",
        answer: {
          summary: "Cluster inventory",
          sections: [{ type: "collection", title: "Nodes", data: ["a", "b"] }],
        },
      },
    });
    const raw = renderAssistantResponse({ content: "plain fallback" });

    expect(structured).toContain("Cluster inventory");
    expect(structured).toContain("Nodes");
    expect(raw).toContain("plain fallback");
  });

  test("promotes repeated 'Entity | VM Name=...' TERSE_DATA rows into a real named table", () => {
    const html = renderRawTextFallback(
      "| Entity | VM Name=opnsense | Node=proxBig | Subnet=172.16.0.1/22 | Exposure Rules=42 |\n" +
      "| Entity | VM Name=opsbox | Node=YANG | Subnet=172.16.0.184/22 | Exposure Rules=42 |\n" +
      "| Total | Total VMs=13 |"
    );

    expect(html).toContain("response-table");
    expect(html).not.toContain("response-ascii-table");
    expect(html).toContain(">opnsense<");
    expect(html).toContain(">opsbox<");
    // First column should be the VM names, not the literal label "Entity"
    expect(html).not.toMatch(/<td><span class="response-scalar">Entity<\/span><\/td>/);
    expect(html).toContain("<th>Node</th>");
    expect(html).toContain("<th>Subnet</th>");
  });
});
