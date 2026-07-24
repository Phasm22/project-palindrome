import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/tools/tool-schema";

describe("zodToJsonSchema", () => {
  test("preserves descriptions on defaulted non-enum fields", () => {
    const schema = z.object({
      enabled: z.boolean().default(true).describe("hello"),
    });

    expect(zodToJsonSchema(schema).properties.enabled).toMatchObject({
      type: "boolean",
      default: true,
      description: "hello",
    });
  });
});
