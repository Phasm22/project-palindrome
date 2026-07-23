import { createHash } from "crypto";
import { z } from "zod";

const DnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Must be a lowercase DNS label");

const DomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Must be a lowercase DNS name"
  );

export const ApplicationAssetSchema = z
  .object({
    id: DnsLabelSchema.describe("Unique asset ID within the VM"),
    kind: z.literal("image"),
    source: z.enum(["generate", "path"]),
    prompt: z.string().min(1).nullable(),
    path: z.string().min(1).nullable(),
    width: z.number().int().min(64).max(8192),
    height: z.number().int().min(64).max(8192),
    format: z.enum(["jpeg", "png", "webp"]),
    destination: z.string().min(1).startsWith("/"),
    altText: z.string().min(1).max(500),
  })
  .superRefine((asset, ctx) => {
    if (asset.source === "generate" && !asset.prompt) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "Generated assets require a prompt",
      });
    }
    if (asset.source === "path" && !asset.path) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Path assets require a source path",
      });
    }
  });

export const ApplicationFirewallRuleSchema = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]),
  action: z.enum(["allow", "deny"]),
  source: z.union([z.literal("any"), z.string().min(1)]),
});

export const ApplicationVmSchema = z.object({
  name: DnsLabelSchema,
  node: z.enum(["proxBig", "yin", "YANG"]),
  cores: z.number().int().min(1).max(64),
  memory: z.number().int().min(512).max(262144),
  diskSize: z.string().regex(/^[1-9]\d*G$/, "Disk size must use Terraform G format"),
  templateId: z.number().int().positive().nullable(),
  datastore: z.string().min(1),
  cloudInitDatastore: z.string().min(1),
  bridge: z.string().min(1),
  vlanId: z.number().int().min(1).max(4094).nullable(),
  sshUsername: DnsLabelSchema,
  bootstrap: z.boolean(),
  services: z.array(z.enum(["nginx", "docker"])),
  firewall: z.object({
    defaultIncoming: z.enum(["allow", "deny"]),
    rules: z.array(ApplicationFirewallRuleSchema),
  }),
  assets: z.array(ApplicationAssetSchema),
});

export const ApplicationSpecSchema = z.object({
  name: DnsLabelSchema,
  domain: DomainSchema,
  description: z.string().max(500),
  identity: z.object({
    protected: z.boolean(),
    provider: z.enum(["ops-authentik", "none"]),
    allowedGroups: z.array(z.string().min(1)),
  }),
  exposure: z.object({
    enabled: z.boolean(),
    backendPort: z.number().int().min(1).max(65535),
    opsboxIp: z.string().min(1),
  }),
  vms: z.array(ApplicationVmSchema).min(1),
});

export const ApplicationManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    requestId: z.string().min(1).max(128),
    operation: z.enum(["deploy", "destroy"]),
    dryRun: z.boolean(),
    rollbackPolicy: z.enum(["automatic", "retain-successful"]),
    applications: z.array(ApplicationSpecSchema).min(1).max(20),
  })
  .superRefine((manifest, ctx) => {
    const applicationNames = new Set<string>();
    const domains = new Set<string>();
    const vmNames = new Set<string>();

    manifest.applications.forEach((application, appIndex) => {
      if (applicationNames.has(application.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["applications", appIndex, "name"],
          message: `Duplicate application name "${application.name}"`,
        });
      }
      applicationNames.add(application.name);

      if (domains.has(application.domain)) {
        ctx.addIssue({
          code: "custom",
          path: ["applications", appIndex, "domain"],
          message: `Duplicate application domain "${application.domain}"`,
        });
      }
      domains.add(application.domain);

      if (application.identity.protected && application.identity.provider === "none") {
        ctx.addIssue({
          code: "custom",
          path: ["applications", appIndex, "identity", "provider"],
          message: "Protected applications require an identity provider",
        });
      }

      application.vms.forEach((vm, vmIndex) => {
        if (vmNames.has(vm.name)) {
          ctx.addIssue({
            code: "custom",
            path: ["applications", appIndex, "vms", vmIndex, "name"],
            message: `Duplicate VM name "${vm.name}"`,
          });
        }
        vmNames.add(vm.name);

        const assetIds = new Set<string>();
        const destinations = new Set<string>();
        vm.assets.forEach((asset, assetIndex) => {
          if (assetIds.has(asset.id)) {
            ctx.addIssue({
              code: "custom",
              path: ["applications", appIndex, "vms", vmIndex, "assets", assetIndex, "id"],
              message: `Duplicate asset ID "${asset.id}"`,
            });
          }
          assetIds.add(asset.id);

          if (destinations.has(asset.destination)) {
            ctx.addIssue({
              code: "custom",
              path: ["applications", appIndex, "vms", vmIndex, "assets", assetIndex, "destination"],
              message: `Duplicate asset destination "${asset.destination}"`,
            });
          }
          destinations.add(asset.destination);
        });
      });
    });
  });

export type ApplicationAsset = z.infer<typeof ApplicationAssetSchema>;
export type ApplicationVm = z.infer<typeof ApplicationVmSchema>;
export type ApplicationSpec = z.infer<typeof ApplicationSpecSchema>;
export type ApplicationManifest = z.infer<typeof ApplicationManifestSchema>;

export function parseApplicationManifest(input: unknown): ApplicationManifest {
  return ApplicationManifestSchema.parse(input);
}

export function hashApplicationManifest(manifest: ApplicationManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
}
