import { describe, expect, test } from "bun:test";
import {
  renderAdaptiveValue,
  renderAssistantResponse,
  renderRawTextFallback,
} from "../../dashboard/js/response-renderer.js";

describe("adaptive response renderer", () => {
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
});
