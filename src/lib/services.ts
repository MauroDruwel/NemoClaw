// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { DASHBOARD_PORT } from "./ports";
import { buildSubprocessEnv } from "./subprocess-env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceOptions {
  /** Sandbox name — must match the name used by start/stop/status. */
  sandboxName?: string;
  /** Dashboard port for cloudflared (default: 18789). */
  dashboardPort?: number;
  /** Repo root directory — used to locate scripts/. */
  repoDir?: string;
  /** Override PID directory (default: /tmp/nemoclaw-services-{sandbox}). */
  pidDir?: string;
  /**
   * Cloudflare named tunnel token from the Zero Trust dashboard.
   * When set, cloudflared runs as a named tunnel (`cloudflared tunnel run --token TOKEN`)
   * instead of a quick tunnel. Falls back to CLOUDFLARE_TUNNEL_TOKEN env var.
   */
  cloudflareTunnelToken?: string;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Colour helpers — respect NO_COLOR
// ---------------------------------------------------------------------------

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const GREEN = useColor ? "\x1b[0;32m" : "";
const RED = useColor ? "\x1b[0;31m" : "";
const YELLOW = useColor ? "\x1b[1;33m" : "";
const NC = useColor ? "\x1b[0m" : "";

function info(msg: string): void {
  console.log(`${GREEN}[services]${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[services]${NC} ${msg}`);
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

function ensurePidDir(pidDir: string): void {
  if (!existsSync(pidDir)) {
    mkdirSync(pidDir, { recursive: true });
  }
}

function readPid(pidDir: string, name: string): number | null {
  const pidFile = join(pidDir, `${name}.pid`);
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning(pidDir: string, name: string): boolean {
  const pid = readPid(pidDir, name);
  if (pid === null) return false;
  return isAlive(pid);
}

function writePid(pidDir: string, name: string, pid: number): void {
  writeFileSync(join(pidDir, `${name}.pid`), String(pid));
}

function removePid(pidDir: string, name: string): void {
  const pidFile = join(pidDir, `${name}.pid`);
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

const SERVICE_NAMES = ["cloudflared"] as const;
type ServiceName = (typeof SERVICE_NAMES)[number];

function startService(
  pidDir: string,
  name: ServiceName,
  command: string,
  args: string[],
  env?: Record<string, string>,
): void {
  if (isRunning(pidDir, name)) {
    const pid = readPid(pidDir, name);
    info(`${name} already running (PID ${String(pid)})`);
    return;
  }

  // Open a single fd for the log file — mirrors bash `>log 2>&1`.
  // Uses child_process.spawn directly because execa's typed API
  // does not accept raw file descriptors for stdio.
  const logFile = join(pidDir, `${name}.log`);
  const logFd = openSync(logFile, "w");
  const subprocess = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: buildSubprocessEnv(env),
  });
  closeSync(logFd);

  // Swallow errors on the detached child (e.g. ENOENT if the command
  // doesn't exist) so Node doesn't crash with an unhandled 'error' event.
  subprocess.on("error", () => {});

  const pid = subprocess.pid;
  if (pid === undefined) {
    warn(`${name} failed to start`);
    return;
  }

  subprocess.unref();
  writePid(pidDir, name, pid);
  info(`${name} started (PID ${String(pid)})`);
}

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(pidDir: string, name: ServiceName): void {
  const pid = readPid(pidDir, name);
  if (pid === null) {
    info(`${name} was not running`);
    return;
  }

  if (!isAlive(pid)) {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return;
  }

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already dead between the check and the signal
    removePid(pidDir, name);
    info(`${name} stopped (PID ${String(pid)})`);
    return;
  }

  // Poll for exit (up to 3 seconds)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isAlive(pid)) {
    // Busy-wait in 100ms increments (synchronous — matches stop being sync)
    const start = Date.now();
    while (Date.now() - start < 100) {
      /* spin */
    }
  }

  // Escalate to SIGKILL if still alive
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  removePid(pidDir, name);
  info(`${name} stopped (PID ${String(pid)})`);
}

// ---------------------------------------------------------------------------
// Tunnel URL helpers
// ---------------------------------------------------------------------------

/**
 * Extract the active tunnel URL from the cloudflared log.
 *
 * Named tunnels (CLOUDFLARE_TUNNEL_TOKEN) log the ingress config as a
 * JSON-escaped string on a config= log line, e.g.:
 *   config="{\"ingress\":[{\"hostname\":\"foo.com\",\"service\":\"http://localhost:18789\"}]}"
 *
 * Quick tunnels log a randomly-assigned *.trycloudflare.com URL.
 */
export function getTunnelUrl(pidDir: string, dashboardPort: number): string {
  const logFile = join(pidDir, "cloudflared.log");
  if (!existsSync(logFile)) return "";
  const log = readFileSync(logFile, "utf-8");

  // Named tunnel: find the ingress entry whose service targets dashboardPort,
  // then extract its hostname.  Use lastIndexOf so that in multi-route tunnels
  // we find the entry immediately before the matching service field.
  const portStr = String(dashboardPort);
  for (const line of log.split("\n")) {
    // The log file contains literal \" sequences (backslash + double-quote).
    // Template-literal \\" produces that two-char sequence in the JS string.
    const serviceKey = `\\"service\\":\\"http://localhost:${portStr}`;
    const sIdx = line.indexOf(serviceKey);
    if (sIdx === -1) continue;
    const prefix = line.slice(0, sIdx);
    const hostnameKey = `\\"hostname\\":\\"`;
    const hIdx = prefix.lastIndexOf(hostnameKey);
    if (hIdx === -1) continue;
    const afterHostname = prefix.slice(hIdx + hostnameKey.length);
    const endIdx = afterHostname.indexOf(`\\"`);
    if (endIdx === -1) continue;
    const hostname = afterHostname.slice(0, endIdx);
    if (hostname) return `https://${hostname}`;
  }

  // Quick tunnel
  const quick = /https:\/\/[a-z0-9-]*\.trycloudflare\.com/.exec(log);
  return quick ? quick[0] : "";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Reject sandbox names that could escape the PID directory via path traversal. */
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateSandboxName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid sandbox name: ${JSON.stringify(name)}`);
  }
  return name;
}

function resolvePidDir(opts: ServiceOptions): string {
  const sandbox = validateSandboxName(
    opts.sandboxName ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME ?? "default",
  );
  return opts.pidDir ?? `/tmp/nemoclaw-services-${sandbox}`;
}

export function showStatus(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);

  console.log("");
  for (const svc of SERVICE_NAMES) {
    if (isRunning(pidDir, svc)) {
      const pid = readPid(pidDir, svc);
      console.log(`  ${GREEN}●${NC} ${svc}  (PID ${String(pid)})`);
    } else {
      console.log(`  ${RED}●${NC} ${svc}  (stopped)`);
    }
  }
  console.log("");

  // Only show tunnel URL if cloudflared is actually running
  if (isRunning(pidDir, "cloudflared")) {
    const dashboardPort = opts.dashboardPort ?? (Number(process.env.DASHBOARD_PORT) || 18789);
    const url = getTunnelUrl(pidDir, dashboardPort);
    if (url) {
      info(`Public URL: ${url}`);
    }
  }
}

export function stopAll(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  stopService(pidDir, "cloudflared");
  info("All services stopped.");
}

export async function startAll(opts: ServiceOptions = {}): Promise<void> {
  const pidDir = resolvePidDir(opts);
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;

  ensurePidDir(pidDir);

  // Messaging (Telegram, Discord, Slack) is now handled natively by OpenClaw
  // inside the sandbox via the OpenShell provider/placeholder/L7-proxy pipeline.
  // No host-side bridge processes are needed. See: PR #1081.

  // cloudflared tunnel
  const tunnelToken =
    opts.cloudflareTunnelToken ?? process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";

  try {
    execSync("command -v cloudflared", {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (tunnelToken) {
      // Named tunnel — routes and hostname are configured in the Cloudflare
      // Zero Trust dashboard; no local --url flag needed.
      startService(pidDir, "cloudflared", "cloudflared", [
        "tunnel",
        "run",
        "--token",
        tunnelToken,
      ]);
    } else {
      // Quick tunnel — assigns a random *.trycloudflare.com URL.
      startService(pidDir, "cloudflared", "cloudflared", [
        "tunnel",
        "--url",
        `http://localhost:${String(dashboardPort)}`,
      ]);
    }
  } catch {
    warn("cloudflared not found — no public URL. Install cloudflared manually if you need one.");
  }

  // Wait for cloudflared URL (works for both named and quick tunnels)
  if (isRunning(pidDir, "cloudflared")) {
    info("Waiting for tunnel URL...");
    for (let i = 0; i < 15; i++) {
      if (getTunnelUrl(pidDir, dashboardPort)) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }

  // Banner
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Services                                  │");
  console.log("  │                                                     │");

  const tunnelUrl = isRunning(pidDir, "cloudflared")
    ? getTunnelUrl(pidDir, dashboardPort)
    : "";

  if (tunnelUrl) {
    console.log(`  │  Public URL:  ${tunnelUrl.padEnd(40)}│`);
  }

  console.log("  │  Messaging:   via OpenClaw native channels (if configured) │");

  console.log("  │                                                     │");
  console.log("  │  Run 'openshell term' to monitor egress approvals   │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

// ---------------------------------------------------------------------------
// Exported status helper (useful for programmatic access)
// ---------------------------------------------------------------------------

export function getServiceStatuses(opts: ServiceOptions = {}): ServiceStatus[] {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  return SERVICE_NAMES.map((name) => {
    const running = isRunning(pidDir, name);
    return {
      name,
      running,
      pid: running ? readPid(pidDir, name) : null,
    };
  });
}
