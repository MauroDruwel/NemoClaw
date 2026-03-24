// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 7 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture, shellQuote } = require("./runner");
const {
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
} = require("./inference-config");
const {
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  shouldPatchCoredns,
} = require("./platform");
const { prompt, ensureApiKey, getCredential } = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const onboardSession = require("./onboard-session");
const policies = require("./policies");
const { checkPortAvailable } = require("./preflight");
const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;

function isNonInteractive() {
  return NON_INTERACTIVE;
}

function note(message) {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check if a sandbox is in Ready state from `openshell sandbox list` output.
 * Strips ANSI codes and exact-matches the sandbox name in the first column.
 */
function isSandboxReady(output, sandboxName) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });
}

/**
 * Determine whether stale NemoClaw gateway output indicates a previous
 * session that should be cleaned up before the port preflight check.
 * @param {string} gwInfoOutput - Raw output from `openshell gateway info -g nemoclaw`.
 * @returns {boolean}
 */
function hasStaleGateway(gwInfoOutput) {
  return typeof gwInfoOutput === "string" && gwInfoOutput.length > 0 && gwInfoOutput.includes("nemoclaw");
}

function isGatewayHealthy(statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") {
  const connected = typeof statusOutput === "string" && statusOutput.includes("Connected");
  if (!connected) return false;

  const namedGatewayKnown = hasStaleGateway(gwInfoOutput);
  const activeGatewayKnown =
    typeof activeGatewayInfoOutput === "string" &&
    activeGatewayInfoOutput.includes("Gateway endpoint:") &&
    !activeGatewayInfoOutput.includes("No gateway metadata found");

  return namedGatewayKnown || activeGatewayKnown;
}

function getGatewayReuseState(statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") {
  if (isGatewayHealthy(statusOutput, gwInfoOutput, activeGatewayInfoOutput)) {
    return "healthy";
  }
  if (hasStaleGateway(gwInfoOutput)) {
    return "stale";
  }
  if (
    typeof activeGatewayInfoOutput === "string" &&
    activeGatewayInfoOutput.includes("Gateway endpoint:") &&
    !activeGatewayInfoOutput.includes("No gateway metadata found")
  ) {
    return "active-unnamed";
  }
  return "missing";
}

function getSandboxStateFromOutputs(sandboxName, getOutput = "", listOutput = "") {
  if (!sandboxName) return "missing";
  if (!getOutput) return "missing";
  return isSandboxReady(listOutput, sandboxName) ? "ready" : "not_ready";
}

function getSandboxReuseState(sandboxName) {
  if (!sandboxName) return "missing";
  const getOutput = runCapture(`openshell sandbox get "${sandboxName}" 2>/dev/null`, { ignoreError: true });
  const listOutput = runCapture("openshell sandbox list 2>&1", { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function repairRecordedSandbox(sandboxName) {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  run(`openshell forward stop 18789 2>/dev/null || true`, { ignoreError: true });
  run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

function streamSandboxCreate(command) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let lastPrintedLine = "";
  let sawProgress = false;
  let settled = false;

  function shouldShowLine(line) {
    return (
      /^  Building image /.test(line) ||
      /^  Context: /.test(line) ||
      /^  Gateway: /.test(line) ||
      /^Successfully built /.test(line) ||
      /^Successfully tagged /.test(line) ||
      /^  Built image /.test(line) ||
      /^  Pushing image /.test(line) ||
      /^\s*\[progress\]/.test(line) ||
      /^  Image .*available in the gateway/.test(line) ||
      /^Created sandbox: /.test(line) ||
      /^✓ /.test(line)
    );
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    if (shouldShowLine(line) && line !== lastPrintedLine) {
      console.log(line);
      lastPrintedLine = line;
      sawProgress = true;
    }
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  return new Promise((resolve) => {
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (pending) flushLine(pending);
      const detail = error && error.code
        ? `spawn failed: ${error.message} (${error.code})`
        : `spawn failed: ${error.message}`;
      lines.push(detail);
      resolve({ status: 1, output: lines.join("\n"), sawProgress: false });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (pending) flushLine(pending);
      resolve({ status: code ?? 1, output: lines.join("\n"), sawProgress });
    });
  });
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  const output = String(versionOutput ?? runCapture("openshell -V", { ignoreError: true })).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) return null;
  return match[1];
}

function getStableGatewayImageRef(versionOutput = null) {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function buildSandboxConfigSyncScript(selectionConfig) {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

function writeSandboxConfigSyncFile(script, tmpDir = os.tmpdir(), now = Date.now()) {
  const scriptFile = path.join(tmpDir, `nemoclaw-sync-${now}.sh`);
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

function shouldIncludeBuildContextPath(sourceRoot, candidatePath) {
  const relative = path.relative(sourceRoot, candidatePath);
  if (!relative || relative === "") return true;

  const segments = relative.split(path.sep);
  const basename = path.basename(candidatePath);
  const excludedSegments = new Set([
    ".venv",
    ".ruff_cache",
    ".pytest_cache",
    ".mypy_cache",
    "__pycache__",
    "node_modules",
    ".git",
  ]);

  if (basename === ".DS_Store" || basename.startsWith("._")) {
    return false;
  }

  return !segments.some((segment) => excludedSegments.has(segment));
}

function copyBuildContextDir(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (candidatePath) => shouldIncludeBuildContextPath(sourceDir, candidatePath),
  });
}

async function promptCloudModel() {
  console.log("");
  console.log("  Cloud models:");
  CLOUD_MODEL_OPTIONS.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option.label} (${option.id})`);
  });
  console.log("");

  const choice = await prompt("  Choose model [1]: ");
  const index = parseInt(choice || "1", 10) - 1;
  return (CLOUD_MODEL_OPTIONS[index] || CLOUD_MODEL_OPTIONS[0]).id;
}

async function promptOllamaModel() {
  const options = getOllamaModelOptions(runCapture);
  const defaultModel = getDefaultOllamaModel(runCapture);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log("  Ollama models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  return options[index] || options[defaultIndex] || defaultModel;
}

function getRequestedSandboxNameHint() {
  const raw = process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

function getResumeSandboxConflict(session) {
  const requestedSandboxName = getRequestedSandboxNameHint();
  if (!requestedSandboxName || !session?.sandboxName) {
    return null;
  }
  return requestedSandboxName !== session.sandboxName
    ? { requestedSandboxName, recordedSandboxName: session.sandboxName }
    : null;
}

function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
  return nonInteractive ? getNonInteractiveProvider() : null;
}

function getRequestedModelHint(nonInteractive = isNonInteractive()) {
  if (!nonInteractive) return null;
  const providerKey = getRequestedProviderHint(nonInteractive) || "cloud";
  return getNonInteractiveModel(providerKey);
}

function getResumeConfigConflicts(session, opts = {}) {
  const conflicts = [];
  const nonInteractive = opts.nonInteractive ?? isNonInteractive();

  const sandboxConflict = getResumeSandboxConflict(session);
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  const requestedProvider = getRequestedProviderHint(nonInteractive);
  if (requestedProvider && session?.provider && requestedProvider !== session.provider) {
    conflicts.push({
      field: "provider",
      requested: requestedProvider,
      recorded: session.provider,
    });
  }

  const requestedModel = getRequestedModelHint(nonInteractive);
  if (requestedModel && session?.model && requestedModel !== session.model) {
    conflicts.push({
      field: "model",
      requested: requestedModel,
      recorded: session.model,
    });
  }

  return conflicts;
}

function isDockerRunning() {
  try {
    runCapture("docker info", { ignoreError: false });
    return true;
  } catch {
    return false;
  }
}

function getContainerRuntime() {
  const info = runCapture("docker info 2>/dev/null", { ignoreError: true });
  return inferContainerRuntime(info);
}

function isOpenshellInstalled() {
  try {
    runCapture("command -v openshell");
    return true;
  } catch {
    return false;
  }
}

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  if (String(pathValue).split(path.delimiter).includes(binDir)) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

function installOpenshell() {
  const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      console.error(output);
    }
    return { installed: false, localBin: null, futureShellPathHint: null };
  }
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const futureShellPathHint = fs.existsSync(openshellPath)
    ? getFutureShellPathHint(localBin, process.env.PATH)
    : null;
  if (fs.existsSync(openshellPath) && futureShellPathHint) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  return {
    installed: isOpenshellInstalled(),
    localBin,
    futureShellPathHint,
  };
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const exists = runCapture(`openshell sandbox get "${sandboxName}" 2>/dev/null`, { ignoreError: true });
    if (exists) return true;
    sleep(delaySeconds);
  }
  return false;
}

function parsePolicyPresetEnv(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSafeModelId(value) {
  return /^[A-Za-z0-9._:/-]+$/.test(value);
}

function getNonInteractiveProvider() {
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;

  const validProviders = new Set(["cloud", "ollama", "vllm", "nim"]);
  if (!validProviders.has(providerKey)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error("  Valid values: cloud, ollama, vllm, nim");
    process.exit(1);
  }

  return providerKey;
}

function getNonInteractiveModel(providerKey) {
  const model = (process.env.NEMOCLAW_MODEL || "").trim();
  if (!model) return null;
  if (!isSafeModelId(model)) {
    console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

// ── Step 1: Preflight ────────────────────────────────────────────

async function preflight() {
  step(1, 7, "Preflight checks");

  // Docker
  if (!isDockerRunning()) {
    console.error("  Docker is not running. Please start Docker and try again.");
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  const runtime = getContainerRuntime();
  if (isUnsupportedMacosRuntime(runtime)) {
    console.error("  Podman on macOS is not supported by NemoClaw at this time.");
    console.error("  OpenShell currently depends on Docker host-gateway behavior that Podman on macOS does not provide.");
    console.error("  Use Colima or Docker Desktop on macOS instead.");
    process.exit(1);
  }
  if (runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${runtime}`);
  }

  // OpenShell CLI
  let openshellInstall = { localBin: null, futureShellPathHint: null };
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  }
  console.log(`  ✓ openshell CLI: ${runCapture("openshell --version 2>/dev/null || echo unknown", { ignoreError: true })}`);
  if (openshellInstall.futureShellPathHint) {
    console.log(`  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`);
    console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    console.log("  Add that export to your shell profile, or open a new terminal before running openshell directly.");
  }

  // Clean up stale NemoClaw session before checking ports.
  // A previous onboard run may have left the gateway container and port
  // forward running.  If a NemoClaw-owned gateway is still present, tear
  // it down so the port check below doesn't fail on our own leftovers.
  const gwInfo = runCapture("openshell gateway info -g nemoclaw 2>/dev/null", { ignoreError: true });
  if (hasStaleGateway(gwInfo)) {
    console.log("  Cleaning up previous NemoClaw session...");
    run("openshell forward stop 18789 2>/dev/null || true", { ignoreError: true });
    run("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });
    console.log("  ✓ Previous session cleaned up");
  }

  // Required ports — gateway (8080) and dashboard (18789)
  const requiredPorts = [
    { port: 8080, label: "OpenShell gateway" },
    { port: 18789, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    const portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      console.error("");
      console.error(`  !! Port ${port} is not available.`);
      console.error(`     ${label} needs this port.`);
      console.error("");
      if (portCheck.process && portCheck.process !== "unknown") {
        console.error(`     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`);
        console.error("");
        console.error("     To fix, stop the conflicting process:");
        console.error("");
        if (portCheck.pid) {
          console.error(`       sudo kill ${portCheck.pid}`);
        } else {
          console.error(`       lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        console.error("       # or, if it's a systemd service:");
        console.error("       systemctl --user stop openclaw-gateway.service");
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: lsof -i :${port} -sTCP:LISTEN`);
      }
      console.error("");
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
  } else if (gpu && gpu.type === "apple") {
    console.log(`  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`);
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  return gpu;
}

// ── Step 2: Gateway ──────────────────────────────────────────────

async function startGateway(gpu) {
  step(2, 7, "Starting OpenShell gateway");

  // Destroy old gateway
  run("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });

  const gwArgs = ["--name", "nemoclaw"];
  // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
  // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
  // sandbox itself does not need direct GPU access. Passing --gpu causes
  // FailedPrecondition errors when the gateway's k3s device plugin cannot
  // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions
  const gatewayEnv = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
    console.log(`  Using pinned OpenShell gateway image: ${stableGatewayImage}`);
  }

  run(`openshell gateway start ${gwArgs.join(" ")}`, {
    ignoreError: false,
    env: gatewayEnv,
  });

  // Verify health
  for (let i = 0; i < 5; i++) {
    const status = runCapture("openshell status 2>&1", { ignoreError: true });
    if (status.includes("Connected")) {
      console.log("  ✓ Gateway is healthy");
      break;
    }
    if (i === 4) {
      console.error("  Gateway failed to start. Run: openshell gateway info");
      process.exit(1);
    }
    sleep(2);
  }

  // CoreDNS fix — always run. k3s-inside-Docker has broken DNS on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS for Colima...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" nemoclaw 2>&1 || true`, { ignoreError: true });
  }
  // Give DNS a moment to propagate
  sleep(5);
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function createSandbox(gpu) {
  step(3, 7, "Creating sandbox");

  const nameAnswer = await promptOrDefault(
    "  Sandbox name (lowercase, numbers, hyphens) [my-assistant]: ",
    "NEMOCLAW_SANDBOX_NAME", "my-assistant"
  );
  const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

  // Validate: RFC 1123 subdomain — lowercase alphanumeric and hyphens,
  // must start and end with alphanumeric (required by Kubernetes/OpenShell)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
    console.error(`  Invalid sandbox name: '${sandboxName}'`);
    console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
    console.error("  and must start and end with a letter or number.");
    process.exit(1);
  }

  // Check if sandbox already exists in registry
  const existing = registry.getSandbox(sandboxName);
  if (existing) {
    if (isNonInteractive()) {
      if (process.env.NEMOCLAW_RECREATE_SANDBOX !== "1") {
        console.error(`  Sandbox '${sandboxName}' already exists.`);
        console.error("  Set NEMOCLAW_RECREATE_SANDBOX=1 to recreate it in non-interactive mode.");
        process.exit(1);
      }
      note(`  [non-interactive] Sandbox '${sandboxName}' exists — recreating`);
    } else {
      const recreate = await prompt(`  Sandbox '${sandboxName}' already exists. Recreate? [y/N]: `);
      if (recreate.toLowerCase() !== "y") {
        console.log("  Keeping existing sandbox.");
        return sandboxName;
      }
    }
    // Destroy old sandbox
    run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context
  const { mkdtempSync } = require("fs");
  const os = require("os");
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
  copyBuildContextDir(path.join(ROOT, "nemoclaw"), path.join(buildCtx, "nemoclaw"));
  copyBuildContextDir(path.join(ROOT, "nemoclaw-blueprint"), path.join(buildCtx, "nemoclaw-blueprint"));
  copyBuildContextDir(path.join(ROOT, "scripts"), path.join(buildCtx, "scripts"));

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const createArgs = [
    `--from "${buildCtx}/Dockerfile"`,
    `--name "${sandboxName}"`,
    `--policy "${basePolicyPath}"`,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const chatUiUrl = process.env.CHAT_UI_URL || 'http://127.0.0.1:18789';
  const envArgs = [`CHAT_UI_URL=${shellQuote(chatUiUrl)}`];
  if (process.env.NVIDIA_API_KEY) {
    envArgs.push(`NVIDIA_API_KEY=${shellQuote(process.env.NVIDIA_API_KEY)}`);
  }
  const discordToken = getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN;
  if (discordToken) {
    envArgs.push(`DISCORD_BOT_TOKEN=${shellQuote(discordToken)}`);
  }
  const slackToken = getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN;
  if (slackToken) {
    envArgs.push(`SLACK_BOT_TOKEN=${shellQuote(slackToken)}`);
  }

  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const createResult = await streamSandboxCreate(
    `openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nemoclaw-start 2>&1`
  );

  // Clean up build context regardless of outcome
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  if (createResult.status !== 0) {
    console.error("");
    console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
    if (createResult.output) {
      console.error("");
      console.error(createResult.output);
    }
    console.error("  Try:  openshell sandbox list        # check gateway state");
    console.error("  Try:  nemoclaw onboard              # retry from scratch");
    process.exit(createResult.status || 1);
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const list = runCapture("openshell sandbox list 2>&1", { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    require("child_process").spawnSync("sleep", ["2"]);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  // Release any stale forward on port 18789 before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  run(`openshell forward stop 18789 2>/dev/null || true`, { ignoreError: true });
  // Forward dashboard port to the new sandbox
  run(`openshell forward start --background 18789 "${sandboxName}"`, { ignoreError: true });

  // Register only after confirmed ready — prevents phantom entries
  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
  });

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 4: NIM ──────────────────────────────────────────────────

async function setupNim(sandboxName, gpu) {
  step(4, 7, "Configuring inference (NIM)");

  let model = null;
  let provider = "nvidia-nim";
  let nimContainer = null;

  // Detect local inference options
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", { ignoreError: true });
  const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive() ? getNonInteractiveModel(requestedProvider || "cloud") : null;
  // Build options list — only show local options with NEMOCLAW_EXPERIMENTAL=1
  const options = [];
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim", label: "Local NIM container (NVIDIA GPU) [experimental]" });
  }
  options.push({
    key: "cloud",
    label:
      "NVIDIA Endpoint API (build.nvidia.com)" +
      (!ollamaRunning && !(EXPERIMENTAL && vllmRunning) ? " (recommended)" : ""),
  });
  if (hasOllama || ollamaRunning) {
    options.push({
      key: "ollama",
      label:
        `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""}` +
        (ollamaRunning ? " (suggested)" : ""),
    });
  }
  if (EXPERIMENTAL && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Existing vLLM instance (localhost:8000) — running [experimental] (suggested)",
    });
  }

  // On macOS without Ollama, offer to install it
  if (!hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
  }

  if (options.length > 1) {
    let selected;

    if (isNonInteractive()) {
      const providerKey = requestedProvider || "cloud";
      selected = options.find((o) => o.key === providerKey);
      if (!selected) {
        console.error(`  Requested provider '${providerKey}' is not available in this environment.`);
        process.exit(1);
      }
      note(`  [non-interactive] Provider: ${selected.key}`);
    } else {
      const suggestions = [];
      if (vllmRunning) suggestions.push("vLLM");
      if (ollamaRunning) suggestions.push("Ollama");
      if (suggestions.length > 0) {
        console.log(`  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`);
        console.log("  Select one explicitly to use it. Press Enter to keep the cloud default.");
        console.log("");
      }

      console.log("");
      console.log("  Inference options:");
      options.forEach((o, i) => {
        console.log(`    ${i + 1}) ${o.label}`);
      });
      console.log("");

      const defaultIdx = options.findIndex((o) => o.key === "cloud") + 1;
      const choice = await prompt(`  Choose [${defaultIdx}]: `);
      const idx = parseInt(choice || String(defaultIdx), 10) - 1;
      selected = options[idx] || options[defaultIdx - 1];
    }

    if (selected.key === "nim") {
      // List models that fit GPU VRAM
      const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= gpu.totalMemoryMB);
      if (models.length === 0) {
        console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
      } else {
        let sel;
        if (isNonInteractive()) {
          if (requestedModel) {
            sel = models.find((m) => m.name === requestedModel);
            if (!sel) {
              console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
              process.exit(1);
            }
          } else {
            sel = models[0];
          }
          note(`  [non-interactive] NIM model: ${sel.name}`);
        } else {
          console.log("");
          console.log("  Models that fit your GPU:");
          models.forEach((m, i) => {
            console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
          });
          console.log("");

          const modelChoice = await prompt(`  Choose model [1]: `);
          const midx = parseInt(modelChoice || "1", 10) - 1;
          sel = models[midx] || models[0];
        }
        model = sel.name;

        console.log(`  Pulling NIM image for ${model}...`);
        nim.pullNimImage(model);

        console.log("  Starting NIM container...");
        nimContainer = nim.startNimContainer(sandboxName, model);

        console.log("  Waiting for NIM to become healthy...");
        if (!nim.waitForNimHealth()) {
          console.error("  NIM failed to start. Falling back to cloud API.");
          model = null;
          nimContainer = null;
        } else {
          provider = "vllm-local";
        }
      }
    } else if (selected.key === "ollama") {
      if (!ollamaRunning) {
        console.log("  Starting Ollama...");
        run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      }
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      if (isNonInteractive()) {
        model = requestedModel || getDefaultOllamaModel(runCapture);
      } else {
        model = await promptOllamaModel();
      }
    } else if (selected.key === "install-ollama") {
      console.log("  Installing Ollama via Homebrew...");
      run("brew install ollama", { ignoreError: true });
      console.log("  Starting Ollama...");
      run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      if (isNonInteractive()) {
        model = requestedModel || getDefaultOllamaModel(runCapture);
      } else {
        model = await promptOllamaModel();
      }
    } else if (selected.key === "vllm") {
      console.log("  ✓ Using existing vLLM on localhost:8000");
      provider = "vllm-local";
      // Query vLLM for the actual model ID
      const vllmModelsRaw = runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });
      try {
        const vllmModels = JSON.parse(vllmModelsRaw);
        if (vllmModels.data && vllmModels.data.length > 0) {
          model = vllmModels.data[0].id;
          if (!isSafeModelId(model)) {
            console.error(`  Detected model ID contains invalid characters: ${model}`);
            process.exit(1);
          }
          console.log(`  Detected model: ${model}`);
        } else {
          console.error("  Could not detect model from vLLM. Please specify manually.");
          process.exit(1);
        }
      } catch {
        console.error("  Could not query vLLM models endpoint. Is vLLM running on localhost:8000?");
        process.exit(1);
      }
    }
    // else: cloud — fall through to default below
  }

  if (provider === "nvidia-nim") {
    if (isNonInteractive()) {
      // In non-interactive mode, NVIDIA_API_KEY must be set via env var
      if (!process.env.NVIDIA_API_KEY) {
        console.error("  NVIDIA_API_KEY is required for cloud provider in non-interactive mode.");
        console.error("  Set it via: NVIDIA_API_KEY=nvapi-... nemoclaw onboard --non-interactive");
        process.exit(1);
      }
    } else {
      await ensureApiKey();
      model = model || (await promptCloudModel()) || DEFAULT_CLOUD_MODEL;
    }
    model = model || requestedModel || DEFAULT_CLOUD_MODEL;
    console.log(`  Using NVIDIA Endpoint API with model: ${model}`);
  }

  registry.updateSandbox(sandboxName, { model, provider, nimContainer });

  return { model, provider };
}

// ── Step 5: Inference provider ───────────────────────────────────

async function setupInference(sandboxName, model, provider) {
  step(5, 7, "Setting up inference provider");

  if (provider === "nvidia-nim") {
    // Create nvidia-nim provider
    run(
      `openshell provider create --name nvidia-nim --type openai ` +
      `--credential ${shellQuote("NVIDIA_API_KEY")} ` +
      `--config "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider nvidia-nim --model ${shellQuote(model)} 2>/dev/null || true`,
      { ignoreError: true }
    );
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    run(
      `OPENAI_API_KEY=dummy ` +
      `openshell provider create --name vllm-local --type openai ` +
      `--credential "OPENAI_API_KEY" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || ` +
      `OPENAI_API_KEY=dummy ` +
      `openshell provider update vllm-local --credential "OPENAI_API_KEY" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider vllm-local --model ${shellQuote(model)} 2>/dev/null || true`,
      { ignoreError: true }
    );
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    run(
      `OPENAI_API_KEY=ollama ` +
      `openshell provider create --name ollama-local --type openai ` +
      `--credential "OPENAI_API_KEY" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || ` +
      `OPENAI_API_KEY=ollama ` +
      `openshell provider update ollama-local --credential "OPENAI_API_KEY" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider ollama-local --model ${shellQuote(model)} 2>/dev/null || true`,
      { ignoreError: true }
    );
    console.log(`  Priming Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = validateOllamaModel(model, runCapture);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
  }

  registry.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
}

// ── Step 6: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName, model, provider) {
  step(6, 7, "Setting up OpenClaw inside sandbox");

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      run(`openshell sandbox connect "${sandboxName}" < ${shellQuote(scriptFile)}`, {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } finally {
      fs.unlinkSync(scriptFile);
    }
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

// ── Step 7: Policy presets ───────────────────────────────────────

async function setupPolicies(sandboxName) {
  step(7, 7, "Policy presets");

  const suggestions = ["pypi", "npm"];

  // Auto-detect based on env tokens
  if (getCredential("TELEGRAM_BOT_TOKEN")) {
    suggestions.push("telegram");
    console.log("  Auto-detected: TELEGRAM_BOT_TOKEN → suggesting telegram preset");
  }
  if (getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN) {
    suggestions.push("slack");
    console.log("  Auto-detected: SLACK_BOT_TOKEN → suggesting slack preset");
  }
  if (getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN) {
    suggestions.push("discord");
    console.log("  Auto-detected: DISCORD_BOT_TOKEN → suggesting discord preset");
  }

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return;
    }

    if (policyMode === "custom" || policyMode === "list") {
      selectedPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (selectedPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (envPresets.length > 0) {
        selectedPresets = envPresets;
      }
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((p) => p.name));
    const invalidPresets = selectedPresets.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
    for (const name of selectedPresets) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
  } else {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const marker = applied.includes(p.name) ? "●" : "○";
      const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
      console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
    });
    console.log("");

    const answer = await prompt(`  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `);

    if (answer.toLowerCase() === "n") {
      console.log("  Skipping policy presets.");
      return;
    }

    if (answer.toLowerCase() === "list") {
      // Let user pick
      const picks = await prompt("  Enter preset names (comma-separated): ");
      const selected = picks.split(",").map((s) => s.trim()).filter(Boolean);
      for (const name of selected) {
        policies.applyPreset(sandboxName, name);
      }
    } else {
      // Apply suggested
      for (const name of suggestions) {
        policies.applyPreset(sandboxName, name);
      }
    }
  }

  console.log("  ✓ Policies applied");
}

// ── Dashboard ────────────────────────────────────────────────────

function printDashboard(sandboxName, model, provider) {
  const nimStat = nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  let providerLabel = provider;
  if (provider === "nvidia-nim") providerLabel = "NVIDIA Endpoint API";
  else if (provider === "vllm-local") providerLabel = "Local vLLM";
  else if (provider === "ollama-local") providerLabel = "Local Ollama";

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  // console.log(`  Dashboard    http://localhost:18789/`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Next:`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

function startRecordedStep(stepName, updates = {}) {
  onboardSession.markStepStarted(stepName);
  if (Object.keys(updates).length > 0) {
    onboardSession.updateSession((session) => {
      if (typeof updates.sandboxName === "string") session.sandboxName = updates.sandboxName;
      if (typeof updates.provider === "string") session.provider = updates.provider;
      if (typeof updates.model === "string") session.model = updates.model;
      return session;
    });
  }
}

function resumeStepMessage(stepName, detail) {
  console.log(`  [resume] Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(opts = {}) {
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  const resume = opts.resume === true;
  let session = null;
  if (resume) {
    session = onboardSession.loadSession();
    if (!session || session.resumable === false) {
      console.error("  No resumable onboarding session was found.");
      console.error("  Run: nemoclaw onboard");
      process.exit(1);
    }
    const resumeConflicts = getResumeConfigConflicts(session, { nonInteractive: isNonInteractive() });
    if (resumeConflicts.length > 0) {
      for (const conflict of resumeConflicts) {
        if (conflict.field === "sandbox") {
          console.error(
            `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`
          );
        } else {
          console.error(
            `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`
          );
        }
      }
      console.error("  Run: nemoclaw onboard              # start a fresh onboarding session");
      console.error("  Or rerun with the original settings to continue that session.");
      process.exit(1);
    }
    onboardSession.updateSession((current) => {
      current.mode = isNonInteractive() ? "non-interactive" : "interactive";
      current.failure = null;
      current.status = "in_progress";
      return current;
    });
    session = onboardSession.loadSession();
  } else {
    session = onboardSession.saveSession(
      onboardSession.createSession({
        mode: isNonInteractive() ? "non-interactive" : "interactive",
        metadata: { gatewayName: "nemoclaw" },
      })
    );
  }

  let completed = false;
  process.once("exit", (code) => {
    if (!completed && code !== 0) {
      const current = onboardSession.loadSession();
      const failedStep = current?.lastStepStarted;
      if (failedStep) {
        onboardSession.markStepFailed(failedStep, "Onboarding exited before the step completed.");
      }
    }
  });

  console.log("");
  console.log("  NemoClaw Onboarding");
  if (isNonInteractive()) note("  (non-interactive mode)");
  if (resume) note("  (resume mode)");
  console.log("  ===================");

  let gpu = null;
  let preflightCompleted = false;
  const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
  if (resumePreflight) {
    resumeStepMessage("preflight", "cached");
    gpu = nim.detectGpu();
    preflightCompleted = true;
  } else {
    startRecordedStep("preflight");
    gpu = await preflight();
    onboardSession.markStepComplete("preflight");
    preflightCompleted = true;
  }

  const gatewayStatus = runCapture("openshell status 2>&1", { ignoreError: true });
  const gatewayInfo = runCapture("openshell gateway info -g nemoclaw 2>/dev/null", { ignoreError: true });
  const activeGatewayInfo = runCapture("openshell gateway info 2>&1", { ignoreError: true });
  const gatewayReuseState = getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);
  const resumeGateway =
    resume &&
    session?.steps?.gateway?.status === "complete" &&
    gatewayReuseState === "healthy";
  if (resumeGateway) {
    resumeStepMessage("gateway", "running");
  } else {
    if (resume && session?.steps?.gateway?.status === "complete") {
      if (gatewayReuseState === "active-unnamed") {
        note("  [resume] Gateway is active but named metadata is missing; recreating it safely.");
      } else if (gatewayReuseState === "stale") {
        note("  [resume] Recorded gateway is unhealthy; recreating it.");
      } else {
        note("  [resume] Recorded gateway state is unavailable; recreating it.");
      }
    }
    startRecordedStep("gateway");
    if (!preflightCompleted) {
      gpu = await preflight();
      preflightCompleted = true;
    }
    await startGateway(gpu);
    onboardSession.markStepComplete("gateway");
  }

  let sandboxName = session?.sandboxName || null;
  const sandboxReuseState = getSandboxReuseState(sandboxName);
  const resumeSandbox = resume && session?.steps?.sandbox?.status === "complete" && sandboxReuseState === "ready";
  if (resumeSandbox) {
    resumeStepMessage("sandbox", sandboxName);
  } else {
    if (resume && session?.steps?.sandbox?.status === "complete") {
      if (sandboxReuseState === "not_ready") {
        note(`  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`);
        repairRecordedSandbox(sandboxName);
      } else {
        note("  [resume] Recorded sandbox state is unavailable; recreating it.");
        if (sandboxName) {
          registry.removeSandbox(sandboxName);
        }
      }
    }
    startRecordedStep("sandbox");
    if (!preflightCompleted) {
      gpu = await preflight();
      preflightCompleted = true;
    }
    sandboxName = await createSandbox(gpu);
    onboardSession.markStepComplete("sandbox", { sandboxName });
  }

  let model = session?.model || null;
  let provider = session?.provider || null;
  const resumeProviderSelection =
    resume &&
    session?.steps?.provider_selection?.status === "complete" &&
    typeof provider === "string" &&
    typeof model === "string";
  if (resumeProviderSelection) {
    resumeStepMessage("provider selection", `${provider} / ${model}`);
  } else {
    startRecordedStep("provider_selection", { sandboxName });
    const selection = await setupNim(sandboxName, gpu);
    model = selection.model;
    provider = selection.provider;
    onboardSession.markStepComplete("provider_selection", { sandboxName, provider, model });
  }

  startRecordedStep("inference", { sandboxName, provider, model });
  await setupInference(sandboxName, model, provider);
  onboardSession.markStepComplete("inference", { sandboxName, provider, model });

  startRecordedStep("openclaw", { sandboxName, provider, model });
  await setupOpenclaw(sandboxName, model, provider);
  onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });

  startRecordedStep("policies", { sandboxName, provider, model });
  await setupPolicies(sandboxName);
  onboardSession.markStepComplete("policies", { sandboxName, provider, model });

  onboardSession.completeSession({ sandboxName, provider, model });
  completed = true;
  printDashboard(sandboxName, model, provider);
}

module.exports = {
  buildSandboxConfigSyncScript,
  copyBuildContextDir,
  getFutureShellPathHint,
  getGatewayReuseState,
  getInstalledOpenshellVersion,
  getRequestedModelHint,
  getRequestedProviderHint,
  getStableGatewayImageRef,
  getResumeConfigConflicts,
  isGatewayHealthy,
  hasStaleGateway,
  getRequestedSandboxNameHint,
  getResumeSandboxConflict,
  getSandboxReuseState,
  getSandboxStateFromOutputs,
  isSandboxReady,
  onboard,
  onboardSession,
  repairRecordedSandbox,
  shouldIncludeBuildContextPath,
  setupNim,
  writeSandboxConfigSyncFile,
};
