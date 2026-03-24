// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const session = require("../bin/lib/onboard-session");

beforeEach(() => {
  session.clearSession();
});

describe("onboard session", () => {
  it("starts empty", () => {
    expect(session.loadSession()).toBeNull();
  });

  it("creates and persists a session with restrictive permissions", () => {
    const created = session.createSession({ mode: "non-interactive" });
    const saved = session.saveSession(created);
    const stat = fs.statSync(session.SESSION_FILE);

    expect(saved.mode).toBe("non-interactive");
    expect(fs.existsSync(session.SESSION_FILE)).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("marks steps started, completed, and failed", () => {
    session.saveSession(session.createSession());
    session.markStepStarted("gateway");
    let loaded = session.loadSession();
    expect(loaded.steps.gateway.status).toBe("in_progress");
    expect(loaded.lastStepStarted).toBe("gateway");

    session.markStepComplete("gateway", { sandboxName: "my-assistant" });
    loaded = session.loadSession();
    expect(loaded.steps.gateway.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");

    session.markStepFailed("sandbox", "Sandbox creation failed");
    loaded = session.loadSession();
    expect(loaded.steps.sandbox.status).toBe("failed");
    expect(loaded.failure.step).toBe("sandbox");
    expect(loaded.failure.message).toMatch(/Sandbox creation failed/);
  });

  it("filters unsafe updates instead of persisting secrets", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "nvidia-nim",
      model: "nvidia/test-model",
      sandboxName: "my-assistant",
      credentialEnv: "NVIDIA_API_KEY",
      apiKey: "nvapi-secret",
      metadata: {
        gatewayName: "nemoclaw",
        token: "secret",
      },
    });

    const loaded = session.loadSession();
    expect(loaded.provider).toBe("nvidia-nim");
    expect(loaded.model).toBe("nvidia/test-model");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.credentialEnv).toBeUndefined();
    expect(loaded.apiKey).toBeUndefined();
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
    expect(loaded.metadata.token).toBeUndefined();
  });

  it("returns null for corrupt session data", () => {
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(session.SESSION_FILE, "not-json");
    expect(session.loadSession()).toBeNull();
  });

  it("summarizes the session for debug output", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepStarted("preflight");
    session.markStepComplete("preflight");
    const summary = session.summarizeForDebug();

    expect(summary.sandboxName).toBe("my-assistant");
    expect(summary.steps.preflight.status).toBe("complete");
    expect(summary.steps.preflight.startedAt).toBeTruthy();
    expect(summary.steps.preflight.completedAt).toBeTruthy();
  });
});
