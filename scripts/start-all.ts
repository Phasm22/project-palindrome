#!/usr/bin/env bun
/**
 * Start all Palindrome services:
 * 1. Docker Compose (Qdrant, Neo4j)
 * 2. Palindrome API Server
 * 3. Dashboard Server
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";

const PROJECT_ROOT = import.meta.dir + "/..";
const LOG_DIR = `${PROJECT_ROOT}/logs`;
const PID_FILE = `${PROJECT_ROOT}/.palindrome-service.pid`;
const STARTUP_CHILD_GRACE_MS = 2000;
let shuttingDown = false;

function emitEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })
  );
}

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const processes: Array<{ name: string; process: ChildProcess; pid?: number }> = [];

function waitForEarlyExit(process: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    process.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 0);
    });
  });
}

// Helper to wait for a service to be ready
async function waitForService(
  name: string,
  checkFn: () => Promise<boolean>,
  timeout = 60000, // Increased to 60 seconds
  interval = 2000   // Check every 2 seconds
): Promise<void> {
  const startTime = Date.now();
  let attempts = 0;
  while (Date.now() - startTime < timeout) {
    attempts++;
    try {
      if (await checkFn()) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ ${name} is ready (${elapsed}s)`);
        return;
      }
    } catch (error) {
      // Service not ready yet
    }
    if (attempts % 5 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`⏳ Still waiting for ${name}... (${elapsed}s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  const elapsed = (timeout / 1000).toFixed(0);
  throw new Error(`${name} did not become ready within ${elapsed} seconds`);
}

// Check if Qdrant is ready
async function checkQdrant(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:6333/");
    return response.ok;
  } catch {
    return false;
  }
}

// Check if Neo4j is ready
async function checkNeo4j(): Promise<boolean> {
  try {
    // Try to connect via bolt (simplified check)
    const response = await fetch("http://localhost:7474", { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// Start Docker Compose
async function startDockerCompose(): Promise<ChildProcess> {
  console.log("🐳 Starting Docker Compose services...");
  
  // Determine compose command
  let composeCmd = "docker";
  let composeArgs = ["compose", "up", "-d"];
  
  // Check if docker compose plugin works
  try {
    const check = spawn("docker", ["compose", "version"], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      check.on("close", (code) => {
        if (code === 0) {
          resolve(undefined);
        } else {
          reject(new Error("docker compose not available"));
        }
      });
    });
  } catch {
    // Fallback to docker-compose
    composeCmd = "docker-compose";
    composeArgs = ["up", "-d"];
  }
  
  const composeProcess = spawn(composeCmd, composeArgs, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  
  composeProcess.stdout?.on("data", (data) => {
    console.log(`[docker-compose] ${data.toString().trim()}`);
  });
  
  composeProcess.stderr?.on("data", (data) => {
    console.error(`[docker-compose] ${data.toString().trim()}`);
  });
  
  await new Promise<void>((resolve, reject) => {
    composeProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker compose exited with code ${code}`));
      }
    });
  });
  
  // Wait for services to be ready
  console.log("⏳ Waiting for Qdrant...");
  await waitForService("Qdrant", checkQdrant);
  
  console.log("⏳ Waiting for Neo4j...");
  await waitForService("Neo4j", checkNeo4j);
  
  // Return a dummy process (docker compose runs in background)
  return composeProcess;
}

// Start Palindrome API Server
function startPalindromeApi(): ChildProcess {
  console.log("🚀 Starting Palindrome API Server...");
  
  const logStream = createWriteStream(`${LOG_DIR}/palindrome-api.log`, { flags: "a" });
  
  const apiProcess = spawn("bun", ["run", "src/pce/api/main.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PCE_API_PORT: process.env.PCE_API_PORT || "4000",
    },
  });
  
  apiProcess.stdout?.on("data", (data) => {
    const msg = data.toString();
    logStream.write(msg);
    console.log(`[palindrome-api] ${msg.trim()}`);
  });
  
  apiProcess.stderr?.on("data", (data) => {
    const msg = data.toString();
    logStream.write(msg);
    console.error(`[palindrome-api] ${msg.trim()}`);
  });
  
  apiProcess.on("exit", (code) => {
    logStream.end();
    emitEvent("service.exited", {
      service: "palindrome-api",
      code: code ?? null,
      signal: null,
      expected: shuttingDown,
    });
    if (code !== 0 && code !== null) {
      console.error(`❌ Palindrome API Server exited with code ${code}`);
    }
  });
  
  return apiProcess;
}

// Start Dashboard Server
function startDashboard(): ChildProcess {
  console.log("🌐 Starting Dashboard Server...");
  
  const logStream = createWriteStream(`${LOG_DIR}/dashboard.log`, { flags: "a" });
  
  const dashboardProcess = spawn("bun", ["run", "dashboard/serve.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  
  dashboardProcess.stdout?.on("data", (data) => {
    const msg = data.toString();
    logStream.write(msg);
    console.log(`[dashboard] ${msg.trim()}`);
  });
  
  dashboardProcess.stderr?.on("data", (data) => {
    const msg = data.toString();
    logStream.write(msg);
    console.error(`[dashboard] ${msg.trim()}`);
  });
  
  dashboardProcess.on("exit", (code) => {
    logStream.end();
    emitEvent("service.exited", {
      service: "dashboard",
      code: code ?? null,
      signal: null,
      expected: shuttingDown,
    });
    if (code !== 0 && code !== null) {
      console.error(`❌ Dashboard Server exited with code ${code}`);
    }
  });
  
  return dashboardProcess;
}

// Graceful shutdown handler
async function shutdown() {
  shuttingDown = true;
  console.log("\n🛑 Shutting down services...");
  
  // Stop processes in reverse order
  for (let i = processes.length - 1; i >= 0; i--) {
    const proc = processes[i];
    if (!proc) continue;
    
    const { name, process } = proc;
    console.log(`Stopping ${name}...`);
    
    if (process.pid) {
      try {
        process.kill("SIGTERM");
        // Wait up to 5 seconds for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            process.kill("SIGKILL");
            resolve();
          }, 5000);
          
          process.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (error) {
        console.error(`Error stopping ${name}:`, error);
      }
    }
  }
  
  // Stop docker compose
  console.log("Stopping Docker Compose...");
  try {
    let composeCmd = "docker";
    let composeArgs = ["compose", "down"];
    
    try {
      await new Promise((resolve, reject) => {
        const check = spawn("docker", ["compose", "version"], { stdio: "ignore" });
        check.on("close", (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error());
        });
      });
    } catch {
      composeCmd = "docker-compose";
      composeArgs = ["down"];
    }
    
    const stopProcess = spawn(composeCmd, composeArgs, {
      cwd: PROJECT_ROOT,
      stdio: "ignore",
    });
    
    await new Promise<void>((resolve) => {
      stopProcess.on("close", () => resolve());
    });
  } catch (error) {
    console.error("Error stopping Docker Compose:", error);
  }
  
  // Remove PID file
  if (existsSync(PID_FILE)) {
    await Bun.write(PID_FILE, "");
  }
  
  console.log("✅ All services stopped");
  process.exit(0);
}

// Main startup
async function main() {
  // Handle signals
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  
  // Write PID file
  await Bun.write(PID_FILE, process.pid.toString());
  
  try {
    // 1. Start Docker Compose
    await startDockerCompose();
    processes.push({ name: "docker-compose", process: {} as ChildProcess });
    
    // 2. Start Palindrome API (wait a bit for services to stabilize)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const palindromeApi = startPalindromeApi();
    processes.push({ name: "palindrome-api", process: palindromeApi, pid: palindromeApi.pid });
    const apiEarlyExit = await waitForEarlyExit(palindromeApi, STARTUP_CHILD_GRACE_MS);
    if (apiEarlyExit !== null) {
      throw new Error(`Palindrome API exited during startup (code=${apiEarlyExit})`);
    }
    
    // 3. Start Dashboard
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const dashboard = startDashboard();
    processes.push({ name: "dashboard", process: dashboard, pid: dashboard.pid });
    const dashboardEarlyExit = await waitForEarlyExit(dashboard, STARTUP_CHILD_GRACE_MS);
    if (dashboardEarlyExit !== null) {
      throw new Error(`Dashboard exited during startup (code=${dashboardEarlyExit})`);
    }
    
    console.log("\n✅ All services started!");
    console.log("\n📊 Service URLs:");
    console.log("  Palindrome API:  http://localhost:4000");
    console.log("  Dashboard:        http://localhost:8080 (or https://localhost:8443)");
    console.log("  Qdrant:          http://localhost:6333/dashboard");
    console.log("  Neo4j:           http://localhost:7474");
    console.log("\n📋 Logs:");
    console.log(`  Palindrome API:  ${LOG_DIR}/palindrome-api.log`);
    console.log(`  Dashboard:      ${LOG_DIR}/dashboard.log`);
    console.log("\n🛑 Stop with: sudo systemctl stop palindrome-services");
    
    // Keep process alive
    process.on("exit", () => {
      shutdown();
    });
    
    // Monitor processes for visibility; systemd handles parent restarts.
    for (const { name, process: proc } of processes) {
      if (proc.pid) {
        proc.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`❌ ${name} crashed with code ${code}. Restarting...`);
            // Note: systemd will handle restarts, but we log it
          }
        });
      }
    }
  } catch (error: any) {
    console.error("❌ Failed to start services:", error.message);
    await shutdown();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
