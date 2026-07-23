import { execFile } from "child_process";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { createVm } from "../compute/create-vm";
import { destroyVm } from "../compute/destroy-vm";
import { AnsibleRunner } from "../helpers/ansible-runner";
import { createDnsRecord } from "../network/create-dns-record";
import {
  ApplicationManifestSchema,
  type ApplicationManifest,
  type ApplicationSpec,
  type ApplicationVm,
} from "./application-manifest";
import {
  generateApplicationAsset,
  type ApplicationAssetArtifact,
} from "./asset-generator";
import {
  ApplicationLifecycleExecutor,
  FileLifecycleJournal,
  type LifecycleHandlerRegistry,
} from "./lifecycle-executor";
import {
  compileApplicationLifecycle,
  type LifecyclePlan,
} from "./lifecycle-compiler";
import { OpsboxApplicationClient } from "./opsbox-application-client";

const execFileAsync = promisify(execFile);

export const ApplicationLifecycleActionSchema = ApplicationManifestSchema;

export interface ApplicationLifecycleActionResult {
  success: boolean;
  dryRun: boolean;
  plan: LifecyclePlan;
  execution?: {
    completedSteps: string[];
    rolledBackSteps: string[];
    failedStep?: string;
    error?: string;
  };
}

type VmConnection = {
  vmName: string;
  hostname: string;
  ip?: string;
  inventoryPath: string;
};

type HandlerResult = {
  connection?: VmConnection;
  artifacts?: ApplicationAssetArtifact[];
  value?: unknown;
};

function runtimeRoot(): string {
  return join(process.cwd(), ".pce");
}

function terraformPaths(
  application: string,
  node: ApplicationVm["node"]
): {
  directory: string;
  tfvarsPath: string;
  statePath: string;
  planPath: string;
} {
  const directory = join(
    runtimeRoot(),
    "application-terraform",
    application,
    node.toLowerCase()
  );
  return {
    directory,
    tfvarsPath: join(directory, "terraform.tfvars"),
    statePath: join(directory, "terraform.tfstate"),
    planPath: join(directory, "tfplan"),
  };
}

function connectionFrom(
  dependencyResults: Record<string, unknown>
): VmConnection {
  for (const result of Object.values(dependencyResults)) {
    const candidate = result as HandlerResult | undefined;
    if (candidate?.connection) return candidate.connection;
  }
  throw new Error("Lifecycle step is missing its VM connection dependency");
}

async function writeInventory(
  requestId: string,
  application: string,
  vmName: string,
  host: string
): Promise<string> {
  const directory = join(
    runtimeRoot(),
    "application-runtime",
    requestId,
    application,
    vmName
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "inventory.ini");
  await writeFile(
    path,
    `[application_vms]\n${vmName} ansible_host=${host} ansible_user=ops\n\n` +
      "[application_vms:vars]\n" +
      "ansible_ssh_common_args='-o StrictHostKeyChecking=no'\n",
    { encoding: "utf-8", mode: 0o600 }
  );
  return path;
}

async function waitForDirectSsh(
  connection: VmConnection,
  timeoutSeconds: number
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const target = `ops@${connection.ip || connection.hostname}`;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await execFileAsync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "StrictHostKeyChecking=no",
          target,
          "true",
        ],
        { timeout: 10_000 }
      );
      return;
    } catch (error: any) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error(
    `Timed out waiting for SSH on ${target}: ${lastError || "unreachable"}`
  );
}

function applicationFor(
  manifest: ApplicationManifest,
  name: string
): ApplicationSpec {
  const application = manifest.applications.find(
    (candidate) => candidate.name === name
  );
  if (!application) throw new Error(`Application "${name}" is not in manifest`);
  return application;
}

function vmFor(
  manifest: ApplicationManifest,
  applicationName: string,
  vmName: string
): ApplicationVm {
  const vm = applicationFor(manifest, applicationName).vms.find(
    (candidate) => candidate.name === vmName
  );
  if (!vm) {
    throw new Error(
      `VM "${vmName}" is not in application "${applicationName}"`
    );
  }
  return vm;
}

async function deleteDnsRecord(domain: string): Promise<void> {
  if (!process.env.PIHOLE_WEB_PWD && !process.env.PIHOLE_API_KEY) return;
  const { getPiholeClient } = await import("../../tools/pihole/client");
  const client = getPiholeClient();
  const records = await client.listDnsRecords();
  const record = records.find(
    (candidate) =>
      candidate.domain.toLowerCase().replace(/\.$/, "") ===
      domain.toLowerCase().replace(/\.$/, "")
  );
  if (record) await client.deleteDnsRecord(record.domain, record.ip);
}

export function createApplicationLifecycleHandlers(
  manifest: ApplicationManifest
): LifecycleHandlerRegistry {
  const ansible = new AnsibleRunner();
  const opsbox = new OpsboxApplicationClient();

  return {
    "reserve-vm": {
      async execute({ step }) {
        return { value: { node: step.node, reserved: true } };
      },
    },
    "create-vm": {
      async execute({ plan, step }) {
        const vm = vmFor(manifest, step.application, step.vm!);
        const paths = terraformPaths(step.application, vm.node);
        await mkdir(paths.directory, { recursive: true });
        const result = await createVm(
          {
            name: vm.name,
            node: vm.node,
            cores: vm.cores,
            memory: vm.memory,
            diskSize: vm.diskSize,
            sshUsername: vm.sshUsername,
            vmBridge: vm.bridge,
            vlanId: vm.vlanId ?? undefined,
            datastore: vm.datastore,
            cloudInitDatastore: vm.cloudInitDatastore,
            templateId: vm.templateId ?? undefined,
            bootstrap: false,
            dryRun: false,
          },
          {
            terraform: {
              tfvarsPath: paths.tfvarsPath,
              baseTfvarsPath: paths.tfvarsPath,
              statePath: paths.statePath,
              planPath: paths.planPath,
            },
            persistSharedConfig: false,
            includeSharedInventory: false,
            manageDns: false,
          }
        );
        if (!result.success || !result.hostname) {
          throw new Error(result.message);
        }
        const ip = result.ipAddresses?.find(
          (candidate) =>
            typeof candidate === "string" &&
            !candidate.startsWith("127.") &&
            !candidate.startsWith("::1")
        );
        const inventoryPath = await writeInventory(
          plan.requestId,
          step.application,
          vm.name,
          ip || result.hostname
        );
        return {
          connection: {
            vmName: vm.name,
            hostname: result.hostname,
            ip,
            inventoryPath,
          },
          value: result,
        };
      },
      async compensate({ step }) {
        const vm = vmFor(manifest, step.application, step.vm!);
        const paths = terraformPaths(step.application, vm.node);
        await destroyVm(
          { name: vm.name, node: vm.node, dryRun: false },
          {
            tfvarsPath: paths.tfvarsPath,
            statePath: paths.statePath,
            removeSharedConfig: false,
          }
        );
      },
    },
    "wait-for-ssh": {
      async execute({ step, dependencyResults }) {
        const connection = connectionFrom(dependencyResults);
        await waitForDirectSsh(
          connection,
          Number(step.parameters.timeout ?? 300)
        );
        return { connection };
      },
    },
    "configure-services": {
      async execute({ step, dependencyResults }) {
        const connection = connectionFrom(dependencyResults);
        const vm = vmFor(manifest, step.application, step.vm!);
        const result = await ansible.runPlaybookWithJson(
          "application-services.yml",
          connection.inventoryPath,
          { application_services: vm.services },
          vm.name
        );
        if (!result.success) {
          throw new Error(result.stderr || "Application service setup failed");
        }
        return { connection, value: result };
      },
    },
    "deploy-assets": {
      async execute({ plan, step, dependencyResults }) {
        const connection = connectionFrom(dependencyResults);
        const vm = vmFor(manifest, step.application, step.vm!);
        const artifacts = await Promise.all(
          vm.assets.map((asset) =>
            generateApplicationAsset(asset, {
              requestId: plan.requestId,
              application: step.application,
              vm: vm.name,
            })
          )
        );
        if (vm.services.includes("nginx")) {
          const result = await ansible.runPlaybookWithJson(
            "nginx-static-site.yml",
            connection.inventoryPath,
            {
              nginx_static_index_title: applicationFor(
                manifest,
                step.application
              ).name,
              nginx_static_assets: artifacts.map((artifact) => ({
                source: artifact.path,
                destination: artifact.destination,
                alt_text:
                  vm.assets.find((asset) => asset.id === artifact.assetId)
                    ?.altText ?? artifact.assetId,
              })),
            },
            vm.name
          );
          if (!result.success) {
            throw new Error(result.stderr || "Static asset deployment failed");
          }
        }
        return { connection, artifacts };
      },
    },
    "configure-firewall": {
      async execute({ step, dependencyResults }) {
        const connection = connectionFrom(dependencyResults);
        const vm = vmFor(manifest, step.application, step.vm!);
        const result = await ansible.runPlaybookWithJson(
          "application-firewall.yml",
          connection.inventoryPath,
          {
            application_firewall_default_incoming:
              vm.firewall.defaultIncoming,
            application_firewall_rules: vm.firewall.rules,
          },
          vm.name
        );
        if (!result.success) {
          throw new Error(result.stderr || "Application firewall setup failed");
        }
        return { connection, value: result };
      },
    },
    "create-dns": {
      async execute({ dependencyResults }) {
        const connection = connectionFrom(dependencyResults);
        if (!connection.ip) {
          throw new Error(`No IP address is available for ${connection.vmName}`);
        }
        const result = await createDnsRecord({
          hostname: `${connection.vmName}.prox`,
          ip: connection.ip,
          domain: ".prox",
          dryRun: false,
        });
        if (!result.success) throw new Error(result.message);
        return { connection, value: result };
      },
    },
    "publish-application": {
      async execute({ step, dependencyResults }) {
        const application = applicationFor(manifest, step.application);
        const primaryVm = application.vms[0]!;
        const primaryResult = dependencyResults[
          `${application.name}:${primaryVm.name}:firewall`
        ] as HandlerResult | undefined;
        const connection =
          primaryResult?.connection ?? connectionFrom(dependencyResults);
        if (!connection.ip) {
          throw new Error(`No backend IP is available for ${application.name}`);
        }
        const backendUrl = `http://${connection.ip}:${application.exposure.backendPort}`;
        await opsbox.publish({ application, backendUrl });
        const dns = await createDnsRecord({
          hostname: application.domain,
          ip: application.exposure.opsboxIp,
          domain: ".prox",
          dryRun: false,
        });
        if (!dns.success) {
          await opsbox.unpublish(application.name);
          throw new Error(dns.message);
        }
        return { connection, value: { backendUrl, dns } };
      },
      async compensate({ step }) {
        const application = applicationFor(manifest, step.application);
        await opsbox.unpublish(application.name);
        await deleteDnsRecord(application.domain);
      },
    },
    "verify-application": {
      async execute({ step }) {
        const application = applicationFor(manifest, step.application);
        const { stdout } = await execFileAsync(
          "curl",
          [
            "-ksS",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--resolve",
            `${application.domain}:443:${application.exposure.opsboxIp}`,
            `https://${application.domain}/`,
          ],
          { timeout: 30_000 }
        );
        const expected = application.identity.protected ? "302" : "200";
        if (stdout.trim() !== expected) {
          throw new Error(
            `Application verification returned HTTP ${stdout.trim()}, expected ${expected}`
          );
        }
        return { value: { status: Number(stdout.trim()) } };
      },
    },
    "unpublish-application": {
      async execute({ step }) {
        const application = applicationFor(manifest, step.application);
        await opsbox.unpublish(application.name);
        await deleteDnsRecord(application.domain);
        return { value: { removed: true } };
      },
    },
    "destroy-vm": {
      async execute({ step }) {
        const vm = vmFor(manifest, step.application, step.vm!);
        const paths = terraformPaths(step.application, vm.node);
        const result = await destroyVm(
          { name: vm.name, node: vm.node, dryRun: false },
          {
            tfvarsPath: paths.tfvarsPath,
            statePath: paths.statePath,
            removeSharedConfig: false,
          }
        );
        if (!result.success) throw new Error(result.message);
        return { value: result };
      },
    },
    "verify-removal": {
      async execute({ step }) {
        const application = applicationFor(manifest, step.application);
        const status = await opsbox.status(application.name);
        if (/"route"\s*:\s*true/.test(status)) {
          throw new Error(`Traefik route for ${application.name} still exists`);
        }
        await rm(
          join(runtimeRoot(), "application-terraform", application.name),
          { recursive: true, force: true }
        );
        return { value: { removed: true } };
      },
    },
  };
}

export async function executeApplicationLifecycle(
  manifest: ApplicationManifest
): Promise<ApplicationLifecycleActionResult> {
  const validated = ApplicationManifestSchema.parse(manifest);
  const plan = compileApplicationLifecycle(validated);
  if (validated.dryRun) {
    return { success: true, dryRun: true, plan };
  }

  const executor = new ApplicationLifecycleExecutor(
    createApplicationLifecycleHandlers(validated),
    {
      maxConcurrency: Number.parseInt(
        process.env.APPLICATION_MAX_CONCURRENCY || "3",
        10
      ),
      journal: new FileLifecycleJournal(),
    }
  );
  const execution = await executor.execute(plan);
  return {
    success: execution.success,
    dryRun: false,
    plan,
    execution: {
      completedSteps: execution.completedSteps,
      rolledBackSteps: execution.rolledBackSteps,
      failedStep: execution.failedStep,
      error: execution.error,
    },
  };
}
