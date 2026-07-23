import { z } from "zod";

export enum TwinRelationshipType {
  HOSTS = "HOSTS",
  RUNS_ON = "RUNS_ON",
  CONNECTS_TO = "CONNECTS_TO",
  ROUTES_TO = "ROUTES_TO",
  ALLOWS = "ALLOWS",
  BLOCKS = "BLOCKS",
  TRANSLATES_TO = "TRANSLATES_TO",
  ATTACHED_TO = "ATTACHED_TO",
  ALIAS_RESOLVES_TO = "ALIAS_RESOLVES_TO",
  EXPOSES = "EXPOSES",
  REACHABLE = "REACHABLE",
  HAS_PORT = "HAS_PORT", // Switch -> SwitchPort
  // SwitchPort <-> NetworkInterface/ComputeNode physical/logical link. Requires
  // MAC-address-table or LLDP/CDP neighbor data to populate with confidence;
  // not yet backfilled (see docs/network/2960g-running-config note on scope).
  LINKED_TO = "LINKED_TO",
  ROUTES_FOR = "ROUTES_FOR", // Switch (via a routed SVI) -> NetworkSubnet
}

const BaseRelationshipSchema = z.object({
  id: z.string().optional(),
  type: z.nativeEnum(TwinRelationshipType),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  metadata: z.record(z.string(), z.any()).optional(),
  collectedAt: z.date().default(() => new Date()),
});

export const HostsRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.HOSTS),
});

export const RunsOnRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.RUNS_ON),
});

export const ConnectsToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.CONNECTS_TO),
});

export const RoutesToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.ROUTES_TO),
});

export const AllowsRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.ALLOWS),
});

export const BlocksRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.BLOCKS),
});

export const TranslatesToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.TRANSLATES_TO),
});

export const AttachedToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.ATTACHED_TO),
});

export const AliasResolvesToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.ALIAS_RESOLVES_TO),
});

export const ExposesRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.EXPOSES),
});

export const ReachableRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.REACHABLE),
});

export const HasPortRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.HAS_PORT),
});

export const LinkedToRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.LINKED_TO),
});

export const RoutesForRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.ROUTES_FOR),
});

export const TwinRelationshipSchema = z.union([
  HostsRelationshipSchema,
  RunsOnRelationshipSchema,
  ConnectsToRelationshipSchema,
  RoutesToRelationshipSchema,
  AllowsRelationshipSchema,
  BlocksRelationshipSchema,
  TranslatesToRelationshipSchema,
  AttachedToRelationshipSchema,
  AliasResolvesToRelationshipSchema,
  ExposesRelationshipSchema,
  ReachableRelationshipSchema,
  HasPortRelationshipSchema,
  LinkedToRelationshipSchema,
  RoutesForRelationshipSchema,
]);

export type TwinRelationship = z.infer<typeof TwinRelationshipSchema>;
