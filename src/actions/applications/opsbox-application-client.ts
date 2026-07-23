import { execFile } from "child_process";
import { promisify } from "util";
import type { ApplicationSpec } from "./application-manifest";

const execFileAsync = promisify(execFile);

export interface OpsboxApplicationClientOptions {
  host?: string;
  scriptPath?: string;
  rootPath?: string;
  timeoutMs?: number;
}

export interface PublishApplicationInput {
  application: ApplicationSpec;
  backendUrl: string;
  applyAuthentik?: boolean;
}

export class OpsboxApplicationClient {
  private readonly host: string;
  private readonly scriptPath: string;
  private readonly rootPath: string;
  private readonly timeoutMs: number;

  constructor(options: OpsboxApplicationClientOptions = {}) {
    this.host = options.host ?? process.env.OPSBOX_SSH_HOST ?? "ops@opsbox.prox";
    this.scriptPath =
      options.scriptPath ??
      "/home/ops/lab-infra/docker-traefik-authentik/scripts/appctl.py";
    this.rootPath =
      options.rootPath ??
      "/home/ops/lab-infra/docker-traefik-authentik";
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  private async execute(arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        this.host,
        "python3",
        this.scriptPath,
        "--root",
        this.rootPath,
        ...arguments_,
      ],
      {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return stdout;
  }

  async plan(input: PublishApplicationInput): Promise<string> {
    return this.execute(this.publishArguments("plan", input));
  }

  async publish(input: PublishApplicationInput): Promise<string> {
    return this.execute(this.publishArguments("publish", input));
  }

  async unpublish(
    applicationName: string,
    applyAuthentik = true
  ): Promise<string> {
    return this.execute([
      "unpublish",
      "--name",
      applicationName,
      ...(applyAuthentik ? ["--apply-authentik"] : []),
    ]);
  }

  async status(applicationName: string): Promise<string> {
    return this.execute(["status", "--name", applicationName]);
  }

  private publishArguments(
    command: "plan" | "publish",
    input: PublishApplicationInput
  ): string[] {
    const { application, backendUrl } = input;
    const arguments_ = [
      command,
      "--name",
      application.name,
      "--domain",
      application.domain,
      "--backend-url",
      backendUrl,
      "--description-base64",
      Buffer.from(application.description, "utf-8").toString("base64"),
    ];
    if (!application.identity.protected) arguments_.push("--unprotected");
    if (
      command === "publish" &&
      input.applyAuthentik !== false &&
      application.identity.protected
    ) {
      arguments_.push("--apply-authentik");
    }
    return arguments_;
  }
}
