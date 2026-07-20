import type { ApplicationManifest } from "../../../src/actions/applications/application-manifest";

export function makeApplicationManifest(
  overrides: Partial<ApplicationManifest> = {}
): ApplicationManifest {
  return {
    schemaVersion: "1",
    requestId: "request-001",
    operation: "deploy",
    dryRun: false,
    rollbackPolicy: "automatic",
    applications: [
      {
        name: "stark",
        domain: "stark.ops.prox",
        description: "Static vehicle page",
        identity: {
          protected: true,
          provider: "ops-authentik",
          allowedGroups: [],
        },
        exposure: {
          enabled: true,
          backendPort: 80,
          opsboxIp: "172.16.0.184",
        },
        vms: [
          {
            name: "stark",
            node: "proxBig",
            cores: 2,
            memory: 4096,
            diskSize: "20G",
            templateId: 8001,
            datastore: "local-lvm",
            cloudInitDatastore: "snippets",
            bridge: "vmbr0",
            vlanId: null,
            sshUsername: "ops",
            bootstrap: false,
            services: ["nginx"],
            firewall: {
              defaultIncoming: "deny",
              rules: [
                {
                  port: 22,
                  protocol: "tcp",
                  action: "allow",
                  source: "any",
                },
                {
                  port: 80,
                  protocol: "tcp",
                  action: "allow",
                  source: "172.16.0.184/32",
                },
              ],
            },
            assets: [
              {
                id: "hero",
                kind: "image",
                source: "generate",
                prompt: "A Nissan Silvia S15 Spec-R at blue hour",
                path: null,
                width: 3840,
                height: 2160,
                format: "jpeg",
                destination: "/var/www/html/hero.jpg",
                altText: "Nissan Silvia S15 Spec-R",
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}
