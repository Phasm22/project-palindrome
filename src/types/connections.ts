import { z } from "zod";

export const ConnectionProtocolSchema = z.enum(["ssh", "http", "https"]);
export const ConnectionStatusSchema = z.enum(["pending", "verified", "failed"]);
export const ConnectionAddressTypeSchema = z.enum(["dns", "ip"]);

export const ConnectionHintSchema = z.object({
  service: z.string().min(1),
  protocol: ConnectionProtocolSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).optional(),
  path: z.string().optional(),
});

export const ConnectionTargetSchema = z.object({
  hostname: z.string().min(1),
  ipAddresses: z.array(z.string()).default([]),
  hints: z.array(ConnectionHintSchema).min(1),
});

export const ConnectionEndpointSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  protocol: ConnectionProtocolSchema,
  host: z.string().min(1),
  addressType: ConnectionAddressTypeSchema,
  port: z.number().int().min(1).max(65535),
  value: z.string().min(1),
  status: ConnectionStatusSchema,
  username: z.string().optional(),
  path: z.string().optional(),
  checkedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  httpStatus: z.number().int().optional(),
  detail: z.string().optional(),
});

export type ConnectionProtocol = z.infer<typeof ConnectionProtocolSchema>;
export type ConnectionHint = z.infer<typeof ConnectionHintSchema>;
export type ConnectionTarget = z.infer<typeof ConnectionTargetSchema>;
export type ConnectionEndpoint = z.infer<typeof ConnectionEndpointSchema>;

