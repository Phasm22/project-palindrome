import type {
  ApplicationManifest,
  ApplicationSpec,
  ApplicationVm,
} from "./application-manifest";
import { hashApplicationManifest } from "./application-manifest";

export const LifecycleStepKinds = [
  "reserve-vm",
  "create-vm",
  "wait-for-ssh",
  "configure-services",
  "deploy-assets",
  "configure-firewall",
  "create-dns",
  "publish-application",
  "verify-application",
  "unpublish-application",
  "destroy-vm",
  "verify-removal",
] as const;

export type LifecycleStepKind = (typeof LifecycleStepKinds)[number];

export interface LifecycleStep {
  id: string;
  idempotencyKey: string;
  kind: LifecycleStepKind;
  application: string;
  vm?: string;
  node?: ApplicationVm["node"];
  dependencies: string[];
  lockKey?: string;
  risk: "WRITE_LOW" | "WRITE_HIGH" | "DESTRUCTIVE";
  parameters: Record<string, unknown>;
  compensation?: LifecycleStepKind;
}

export interface LifecyclePlan {
  requestId: string;
  manifestHash: string;
  operation: ApplicationManifest["operation"];
  rollbackPolicy: ApplicationManifest["rollbackPolicy"];
  steps: LifecycleStep[];
}

function makeStep(
  manifest: ApplicationManifest,
  partial: Omit<LifecycleStep, "idempotencyKey">
): LifecycleStep {
  return {
    ...partial,
    idempotencyKey: `${manifest.requestId}:${hashApplicationManifest(manifest)}:${partial.id}`,
  };
}

function compileVmDeploySteps(
  manifest: ApplicationManifest,
  application: ApplicationSpec,
  vm: ApplicationVm
): LifecycleStep[] {
  const prefix = `${application.name}:${vm.name}`;
  const reserveId = `${prefix}:reserve`;
  const createId = `${prefix}:create`;
  const waitId = `${prefix}:wait-ssh`;
  const servicesId = `${prefix}:services`;
  const assetsId = `${prefix}:assets`;
  const firewallId = `${prefix}:firewall`;
  const dnsId = `${prefix}:dns`;
  const allocationScope =
    vm.node === "yin" || vm.node === "YANG" ? "yin-yang" : "proxbig";

  return [
    makeStep(manifest, {
      id: reserveId,
      kind: "reserve-vm",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [],
      lockKey: `vm-allocation:${allocationScope}`,
      risk: "WRITE_LOW",
      parameters: { node: vm.node, preferredName: vm.name },
    }),
    makeStep(manifest, {
      id: createId,
      kind: "create-vm",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [reserveId],
      lockKey: `terraform:${allocationScope}`,
      risk: "WRITE_HIGH",
      parameters: { vm },
      compensation: "destroy-vm",
    }),
    makeStep(manifest, {
      id: waitId,
      kind: "wait-for-ssh",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [createId],
      risk: "WRITE_LOW",
      parameters: { vmName: vm.name, timeout: 300 },
    }),
    makeStep(manifest, {
      id: servicesId,
      kind: "configure-services",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [waitId],
      risk: "WRITE_LOW",
      parameters: { vmName: vm.name, services: vm.services, bootstrap: vm.bootstrap },
    }),
    makeStep(manifest, {
      id: assetsId,
      kind: "deploy-assets",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [servicesId],
      risk: "WRITE_LOW",
      parameters: { vmName: vm.name, assets: vm.assets },
    }),
    makeStep(manifest, {
      id: firewallId,
      kind: "configure-firewall",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [servicesId],
      risk: "WRITE_HIGH",
      parameters: { vmName: vm.name, firewall: vm.firewall },
    }),
    makeStep(manifest, {
      id: dnsId,
      kind: "create-dns",
      application: application.name,
      vm: vm.name,
      node: vm.node,
      dependencies: [createId],
      risk: "WRITE_LOW",
      parameters: { domain: `${vm.name}.prox`, vmName: vm.name },
    }),
  ];
}

function compileDeployPlan(manifest: ApplicationManifest): LifecycleStep[] {
  const steps: LifecycleStep[] = [];

  for (const application of manifest.applications) {
    for (const vm of application.vms) {
      steps.push(...compileVmDeploySteps(manifest, application, vm));
    }

    const publishDependencies = steps
      .filter(
        (step) =>
          step.application === application.name &&
          ["deploy-assets", "configure-firewall", "create-dns"].includes(step.kind)
      )
      .map((step) => step.id);
    const publishId = `${application.name}:publish`;

    steps.push(
      makeStep(manifest, {
        id: publishId,
        kind: "publish-application",
        application: application.name,
        dependencies: publishDependencies,
        lockKey: `opsbox-application:${application.name}`,
        risk: "WRITE_HIGH",
        parameters: { application },
        compensation: "unpublish-application",
      }),
      makeStep(manifest, {
        id: `${application.name}:verify`,
        kind: "verify-application",
        application: application.name,
        dependencies: [publishId],
        risk: "WRITE_LOW",
        parameters: { application },
      })
    );
  }

  return steps;
}

function compileDestroyPlan(manifest: ApplicationManifest): LifecycleStep[] {
  const steps: LifecycleStep[] = [];

  for (const application of manifest.applications) {
    const unpublishId = `${application.name}:unpublish`;
    steps.push(
      makeStep(manifest, {
        id: unpublishId,
        kind: "unpublish-application",
        application: application.name,
        dependencies: [],
        lockKey: `opsbox-application:${application.name}`,
        risk: "DESTRUCTIVE",
        parameters: { application },
      })
    );

    const destroyIds: string[] = [];
    for (const vm of application.vms) {
      const destroyId = `${application.name}:${vm.name}:destroy`;
      destroyIds.push(destroyId);
      steps.push(
        makeStep(manifest, {
          id: destroyId,
          kind: "destroy-vm",
          application: application.name,
          vm: vm.name,
          node: vm.node,
          dependencies: [unpublishId],
          lockKey: `terraform:${application.name}:${vm.node.toLowerCase()}`,
          risk: "DESTRUCTIVE",
          parameters: { vmName: vm.name, node: vm.node },
        })
      );
    }

    steps.push(
      makeStep(manifest, {
        id: `${application.name}:verify-removal`,
        kind: "verify-removal",
        application: application.name,
        dependencies: destroyIds,
        risk: "WRITE_LOW",
        parameters: { application },
      })
    );
  }

  return steps;
}

function validatePlan(steps: LifecycleStep[]): void {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    throw new Error("Lifecycle plan contains duplicate step IDs");
  }

  for (const step of steps) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Step "${step.id}" depends on unknown step "${dependency}"`);
      }
      if (dependency === step.id) {
        throw new Error(`Step "${step.id}" cannot depend on itself`);
      }
    }
  }
}

export function compileApplicationLifecycle(
  manifest: ApplicationManifest
): LifecyclePlan {
  const steps =
    manifest.operation === "deploy"
      ? compileDeployPlan(manifest)
      : compileDestroyPlan(manifest);

  validatePlan(steps);

  return {
    requestId: manifest.requestId,
    manifestHash: hashApplicationManifest(manifest),
    operation: manifest.operation,
    rollbackPolicy: manifest.rollbackPolicy,
    steps,
  };
}
