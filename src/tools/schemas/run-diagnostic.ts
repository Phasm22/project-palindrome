import { z } from "zod";

const HOST_REGEX = /^[a-zA-Z0-9.-]+$/;

export const RunDiagnosticParams = z.object({
  command: z
    .enum(["ping", "traceroute", "http_check"])
    .describe("Diagnostic routine to execute"),
  target: z
    .string()
    .min(1)
    .describe("Hostname or URL to inspect"),
  packets: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("Packet count for ping"),
  maxHops: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe("Hop ceiling for traceroute"),
  timeoutMs: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .default(5000)
    .describe("Command timeout in milliseconds")
});

export type RunDiagnosticParamsType = z.infer<typeof RunDiagnosticParams>;

export const RunDiagnosticJSONSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["ping", "traceroute", "http_check"],
      description: "Diagnostic routine to execute"
    },
    target: {
      type: "string",
      minLength: 1,
      description: "Hostname or URL to inspect"
    },
    packets: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "Packet count for ping",
      default: 3
    },
    maxHops: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      description: "Hop ceiling for traceroute",
      default: 10
    },
    timeoutMs: {
      type: "integer",
      minimum: 500,
      maximum: 20000,
      description: "Command timeout in milliseconds",
      default: 5000
    }
  },
  required: ["command", "target"],
  additionalProperties: false
} as const;

export function isHostLike(value: string) {
  return HOST_REGEX.test(value);
}
