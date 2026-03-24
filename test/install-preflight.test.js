// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const LEGACY_INSTALLER_WRAPPER = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const GITHUB_INSTALL_URL = "git+https://github.com/NVIDIA/NemoClaw.git";
const TEST_SYSTEM_PATH = "/usr/bin:/bin";

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

/** Fake node that reports v22.14.0. */
function writeNodeStub(fakeBin) {
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.14.0"; exit 0; fi
if [ "$1" = "-e" ]; then
  if [[ "$2" == *"dependencies.openclaw"* ]]; then
    echo "2026.3.11"
    exit 0
  fi
  exit 0
fi
exit 99`,
  );
}

/**
 * Minimal npm stub. Handles --version, config-get-prefix, and a custom
 * install handler injected as a shell snippet via NPM_INSTALL_HANDLER.
 */
function writeNpmStub(fakeBin, installSnippet = "exit 0") {
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "$NPM_PREFIX"; exit 0; fi
if [ "$1" = "install" ] || [ "$1" = "link" ] || [ "$1" = "uninstall" ] || [ "$1" = "pack" ] || [ "$1" = "run" ]; then
  ${installSnippet}
fi
echo "unexpected npm invocation: $*" >&2; exit 98`,
  );
}

// ---------------------------------------------------------------------------

describe("installer runtime preflight", () => {
  it("fails fast with a clear message on unsupported Node.js and npm", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-preflight-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v18.19.1"
  exit 0
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "9.8.1"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/Unsupported runtime detected/);
    expect(output).toMatch(/Node\.js >=20 and npm >=10/);
    expect(output).toMatch(/v18\.19\.1/);
    expect(output).toMatch(/9\.8\.1/);
  });

  it("uses the HTTPS GitHub fallback when not installing from a repo checkout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-fallback-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ]; then
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "v0.1.0-test"
  exit 0
fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitLog, "utf-8")).toMatch(/clone.*NemoClaw\.git/);
  });

  it("prints the HTTPS GitHub remediation when the binary is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-remediation-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(output).not.toMatch(/npm install -g nemoclaw/);
  });

  it("legacy scripts/install.sh delegates to the root installer from a repo checkout", () => {
    const result = spawnSync("bash", [LEGACY_INSTALLER_WRAPPER, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/deprecated compatibility wrapper/);
    expect(output).toMatch(/https:\/\/www\.nvidia\.com\/nemoclaw\.sh/);
    expect(output).toMatch(/NemoClaw Installer/);
  });

  it("legacy scripts/install.sh fails clearly when run without the repo root installer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-installer-stdin-"));
    const scriptContents = fs.readFileSync(LEGACY_INSTALLER_WRAPPER, "utf-8");
    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: scriptContents,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/deprecated compatibility wrapper/);
    expect(output).toMatch(/supported installer/);
    expect(output).toMatch(/https:\/\/www\.nvidia\.com\/nemoclaw\.sh/);
    expect(output).toMatch(/only works from a NemoClaw repository checkout/);
  });

  it("--help exits 0 and shows install usage", () => {
    const result = spawnSync("bash", [INSTALLER, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoClaw Installer/);
    expect(output).toMatch(/--non-interactive/);
    expect(output).toMatch(/--version/);
    expect(output).toMatch(/NEMOCLAW_PROVIDER/);
    expect(output).toMatch(/NEMOCLAW_POLICY_MODE/);
    expect(output).toMatch(/NEMOCLAW_SANDBOX_NAME/);
    expect(output).toMatch(/nvidia\.com\/nemoclaw\.sh/);
  });

  it("--version exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "--version"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/nemoclaw-installer v\d+\.\d+\.\d+/);
  });

  it("-v exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "-v"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/nemoclaw-installer v\d+\.\d+\.\d+/);
  });

  it("uses npm install + npm link for a source checkout (no -g)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-source-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const npmLog = path.join(tmp, "npm.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeNpmStub(
      fakeBin,
      `printf '%s\\n' "$*" >> "$NPM_LOG_PATH"
if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then exit 0; fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    // Write a package.json that triggers the source-checkout path.
    // Must use spaces after colons to match the grep in install.sh.
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, "nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "nemoclaw", "package.json"),
      JSON.stringify({ name: "nemoclaw-plugin", version: "0.1.0" }, null, 2),
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        NPM_LOG_PATH: npmLog,
      },
    });

    expect(result.status).toBe(0);
    const log = fs.readFileSync(npmLog, "utf-8");
    // install (no -g) and link must both have been called
    expect(log).toMatch(/^install(?!\s+-g)/m);
    expect(log).toMatch(/^link/m);
    // the GitHub URL must NOT appear — this is a local install
    expect(log).not.toMatch(new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("spin() non-TTY: dumps wrapped-command output and exits non-zero on failure", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-spin-fail-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  echo "ENOTFOUND simulated network error" >&2
  exit 1
fi
if [ "$1" = "install" ] || [ "$1" = "run" ] || [ "$1" = "link" ]; then
  echo "ENOTFOUND simulated network error" >&2
  exit 1
fi`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ENOTFOUND simulated network error/);
  });

  it("creates a user-local shim when npm installs outside the current PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-shim-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".local"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ]; then
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "v0.1.0-test"
  exit 0
fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.9"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw");
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(shimPath)).toBe(path.join(prefix, "bin", "nemoclaw"));
    expect(`${result.stdout}${result.stderr}`).toMatch(/Created user-local shim/);
  });

  it("does not print PATH recovery instructions when nemoclaw is already usable in this shell", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-ready-shell-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const nvmDir = path.join(tmp, ".nvm");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(path.join(nvmDir, "nvm.sh"), "# stub nvm\n");

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then
  exit 0
fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.9"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/current shell cannot resolve 'nemoclaw'/);
    expect(output).not.toMatch(/source .*\.bashrc|source .*\.zshrc|source .*\.profile/);
  });
});
