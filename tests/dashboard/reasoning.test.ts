import { beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => {
  globalThis.window = {
    location: { protocol: "http:", host: "localhost" },
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    createElement: () => {
      let value = "";
      return {
        set textContent(text: unknown) {
          value = String(text)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        },
        get innerHTML() {
          return value;
        },
      };
    },
  } as unknown as Document;
});

describe("reasoning tool-result formatter", () => {
  test("escapes entity values and malformed result fallbacks", async () => {
    const { formatToolResult } = await import("../../dashboard/js/reasoning.js");
    const attack = "<img src=x onerror=alert(1)>";

    const entityHtml = formatToolResult({
      entities: [{ type: attack, name: attack }],
    });
    const fallbackHtml = formatToolResult(attack);

    expect(entityHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(entityHtml).not.toContain(attack);
    expect(fallbackHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(fallbackHtml).not.toContain(attack);
  });
});
