import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import type {
  ConnectionEndpoint,
  ConnectionHint,
  ConnectionTarget,
} from "../types/connections";

const execFileAsync = promisify(execFile);

type DnsLookup = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

function configuredDnsLookup(): DnsLookup {
  let server = process.env.CONNECTION_DNS_SERVER;
  if (!server && process.env.PIHOLE_URL) {
    try {
      const hostname = new URL(process.env.PIHOLE_URL).hostname;
      if (isIP(hostname)) server = hostname;
    } catch {
      // Fall through to the operating-system resolver.
    }
  }
  if (!server) return lookup as DnsLookup;

  const resolver = new Resolver();
  resolver.setServers([server]);
  return async (hostname) => {
    let addresses: Array<{ address: string; family: number }> = [];
    try {
      addresses = (await resolver.resolve4(hostname)).map((address) => ({ address, family: 4 }));
    } catch {
      try {
        addresses = (await resolver.resolve6(hostname)).map((address) => ({ address, family: 6 }));
      } catch {
        addresses = [];
      }
    }
    if (addresses.length === 0) throw new Error(`DNS server ${server} returned no addresses for ${hostname}`);
    return addresses;
  };
}

export type ConnectionVerificationOptions = {
  signal?: AbortSignal;
  retryIntervalMs?: number;
  sshDeadlineMs?: number;
  httpDeadlineMs?: number;
  attemptTimeoutMs?: number;
  onUpdate?: (endpoints: ConnectionEndpoint[]) => void | Promise<void>;
  dnsLookup?: DnsLookup;
  sshCheck?: (endpoint: ConnectionEndpoint, signal?: AbortSignal) => Promise<void>;
  httpCheck?: (endpoint: ConnectionEndpoint, signal?: AbortSignal) => Promise<number>;
};

function usableIps(values: string[]): string[] {
  return [...new Set(values.map(String).filter((ip) =>
    ip && ip !== "IP pending..." && !ip.startsWith("127.") && ip !== "::1"
  ))];
}

function endpointValue(hint: ConnectionHint, host: string): string {
  if (hint.protocol === "ssh") {
    return `ssh -p ${hint.port} ${hint.username || "ops"}@${host}`;
  }
  const path = hint.path?.startsWith("/") ? hint.path : `/${hint.path || ""}`;
  return `${hint.protocol}://${host}:${hint.port}${path}`;
}

function transportEndpoint(endpoint: ConnectionEndpoint, host: string): ConnectionEndpoint {
  if (endpoint.protocol === "ssh") {
    return { ...endpoint, host, value: `ssh -p ${endpoint.port} ${endpoint.username || "ops"}@${host}` };
  }
  const path = endpoint.path?.startsWith("/") ? endpoint.path : `/${endpoint.path || ""}`;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return { ...endpoint, host, value: `${endpoint.protocol}://${urlHost}:${endpoint.port}${path}` };
}

export function buildConnectionEndpoints(target: ConnectionTarget): ConnectionEndpoint[] {
  const ips = usableIps(target.ipAddresses);
  const hosts = [
    ...(target.hostname ? [{ host: target.hostname, addressType: "dns" as const }] : []),
    ...ips.map((host) => ({ host, addressType: "ip" as const })),
  ];

  return target.hints.flatMap((hint) => hosts.map(({ host, addressType }) => ({
    id: `${hint.service}:${hint.protocol}:${hint.port}:${addressType}:${host}`,
    service: hint.service,
    protocol: hint.protocol,
    host,
    addressType,
    port: hint.port,
    value: endpointValue(hint, host),
    status: "pending" as const,
    ...(hint.username ? { username: hint.username } : {}),
    ...(hint.path ? { path: hint.path } : {}),
  })));
}

export async function resolveConnectionTarget(
  target: ConnectionTarget,
  dnsLookup: DnsLookup = configuredDnsLookup()
): Promise<ConnectionTarget> {
  if (usableIps(target.ipAddresses).length > 0 || !target.hostname) return target;
  try {
    const resolved = await dnsLookup(target.hostname, { all: true });
    return {
      ...target,
      ipAddresses: resolved.map((entry) => entry.address),
    };
  } catch {
    return target;
  }
}

async function defaultSshCheck(endpoint: ConnectionEndpoint, signal?: AbortSignal): Promise<void> {
  const timeoutSeconds = 5;
  await execFileAsync("ssh", [
    "-p", String(endpoint.port),
    "-o", `ConnectTimeout=${timeoutSeconds}`,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    `${endpoint.username || "ops"}@${endpoint.host}`,
    "true",
  ], { timeout: timeoutSeconds * 1000 + 1000, signal });
}

async function defaultHttpCheck(endpoint: ConnectionEndpoint, signal?: AbortSignal): Promise<number> {
  const response = await fetch(endpoint.value, {
    method: "GET",
    redirect: "manual",
    signal,
  });
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  await response.body?.cancel().catch(() => {});
  return response.status;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

export async function verifyConnectionEndpoints(
  candidates: ConnectionEndpoint[],
  expectedIps: string[],
  options: ConnectionVerificationOptions = {}
): Promise<ConnectionEndpoint[]> {
  const results = candidates.map((endpoint) => ({ ...endpoint }));
  const retryIntervalMs = options.retryIntervalMs ?? 5000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 7000;
  const dnsLookup = options.dnsLookup ?? configuredDnsLookup();
  const sshCheck = options.sshCheck ?? defaultSshCheck;
  const httpCheck = options.httpCheck ?? defaultHttpCheck;
  const validExpectedIps = usableIps(expectedIps);

  await options.onUpdate?.(results.map((item) => ({ ...item })));

  await Promise.all(results.map(async (endpoint, index) => {
    const startedAt = Date.now();
    const deadlineMs = endpoint.protocol === "ssh"
      ? options.sshDeadlineMs ?? 300_000
      : options.httpDeadlineMs ?? 120_000;
    let lastError = "Verification did not run";

    while (Date.now() - startedAt < deadlineMs) {
      options.signal?.throwIfAborted();
      const attemptController = new AbortController();
      const attemptTimer = setTimeout(() => attemptController.abort(), attemptTimeoutMs);
      const abortAttempt = () => attemptController.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortAttempt, { once: true });
      try {
        let checkEndpoint = endpoint;
        if (endpoint.addressType === "dns") {
          const resolved = await dnsLookup(endpoint.host, { all: true });
          const addresses = resolved.map((entry) => entry.address);
          if (validExpectedIps.length > 0 && !addresses.some((address) => validExpectedIps.includes(address))) {
            throw new Error(`DNS resolved to ${addresses.join(", ") || "no addresses"}, expected ${validExpectedIps.join(", ")}`);
          }
          const resolvedTransportIp = addresses.find((address) => validExpectedIps.includes(address)) || addresses[0];
          if (!resolvedTransportIp) throw new Error("DNS returned no transport address");
          checkEndpoint = transportEndpoint(endpoint, resolvedTransportIp);
        }

        let httpStatus: number | undefined;
        if (endpoint.protocol === "ssh") {
          await sshCheck(checkEndpoint, attemptController.signal);
        } else {
          httpStatus = await httpCheck(checkEndpoint, attemptController.signal);
        }

        results[index] = {
          ...endpoint,
          status: "verified",
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          ...(httpStatus ? { httpStatus } : {}),
          detail: endpoint.protocol === "ssh" ? "Authenticated SSH check passed" : "Service responded successfully",
        };
        await options.onUpdate?.(results.map((item) => ({ ...item })));
        return;
      } catch (error) {
        options.signal?.throwIfAborted();
        lastError = conciseError(error);
      } finally {
        clearTimeout(attemptTimer);
        options.signal?.removeEventListener("abort", abortAttempt);
      }

      const remainingMs = deadlineMs - (Date.now() - startedAt);
      if (remainingMs > 0) await delay(Math.min(retryIntervalMs, remainingMs), options.signal);
    }

    results[index] = {
      ...endpoint,
      status: "failed",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      detail: lastError,
    };
    await options.onUpdate?.(results.map((item) => ({ ...item })));
  }));

  return results;
}
