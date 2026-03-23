// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const onboardPath = require.resolve("../bin/lib/onboard.js");
const credentialsPath = require.resolve("../bin/lib/credentials.js");
const runnerPath = require.resolve("../bin/lib/runner.js");
const registryPath = require.resolve("../bin/lib/registry.js");
const sidecarPath = require.resolve("../bin/lib/sidecar.js");

function loadSelectInferenceProvider({
  promptImpl,
  runCaptureImpl,
  updateSandboxImpl = () => {},
  getSidecarImpl = null,
  env = {},
} = {}) {
  const originalExperimental = process.env.NEMOCLAW_EXPERIMENTAL;
  Object.assign(process.env, env);

  delete require.cache[onboardPath];
  delete require.cache[credentialsPath];
  delete require.cache[runnerPath];
  delete require.cache[registryPath];
  delete require.cache[sidecarPath];

  const credentials = require(credentialsPath);
  const runner = require(runnerPath);
  const registry = require(registryPath);
  const sidecar = require(sidecarPath);

  credentials.prompt = promptImpl || (async () => "");
  credentials.ensureApiKey = async () => {};
  runner.runCapture = runCaptureImpl || (() => "");
  registry.updateSandbox = updateSandboxImpl;

  if (getSidecarImpl) {
    sidecar.getSidecar = getSidecarImpl;
  }

  const onboard = require(onboardPath);

  return {
    restore() {
      if (originalExperimental === undefined) delete process.env.NEMOCLAW_EXPERIMENTAL;
      else process.env.NEMOCLAW_EXPERIMENTAL = originalExperimental;
      delete require.cache[onboardPath];
      delete require.cache[credentialsPath];
      delete require.cache[runnerPath];
      delete require.cache[registryPath];
      delete require.cache[sidecarPath];
    },
    selectInferenceProvider: onboard.selectInferenceProvider,
  };
}

afterEach(() => {
  delete process.env.NEMOCLAW_EXPERIMENTAL;
});

describe("onboard provider selection UX", () => {
  it("prompts explicitly instead of silently auto-selecting detected Ollama", async () => {
    let promptCalls = 0;
    const messages = [];
    const updates = [];
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));

    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      promptImpl: async (message) => {
        promptCalls += 1;
        messages.push(message);
        return "";
      },
      runCaptureImpl: (command) => {
        if (command.includes("command -v ollama")) return "/usr/bin/ollama";
        if (command.includes("localhost:11434/api/tags")) {
          return JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] });
        }
        if (command.includes("ollama list")) {
          return "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now";
        }
        if (command.includes("localhost:8000/v1/models")) return "";
        return "";
      },
      updateSandboxImpl: (_name, update) => updates.push(update),
    });

    try {
      const result = await selectInferenceProvider("selection-test", null);
      expect(result.provider).toBe("nvidia-nim");
      expect(result.model).toBe("nvidia/nemotron-3-super-120b-a12b");
      expect(promptCalls).toBe(2);
      expect(messages[0]).toMatch(/Choose \[/);
      expect(messages[1]).toMatch(/Choose model \[1\]/);
      expect(lines.some((line) => line.includes("Detected local inference option"))).toBeTruthy();
      expect(lines.some((line) => line.includes("Press Enter to keep the cloud default"))).toBeTruthy();
      expect(lines.some((line) => line.includes("Cloud models:"))).toBeTruthy();
      expect(updates).toEqual([
        {
          model: "nvidia/nemotron-3-super-120b-a12b",
          nimContainer: null,
          provider: "nvidia-nim",
        },
      ]);
    } finally {
      console.log = originalLog;
      restore();
    }
  });

  it("uses the sidecar option as the default in Linux local-first mode", async () => {
    const prompts = [];
    const started = [];
    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      env: { NEMOCLAW_EXPERIMENTAL: "1" },
      promptImpl: async (message) => {
        prompts.push(message);
        if (message.includes("Choose [")) return "";
        return "1";
      },
      runCaptureImpl: (command) => {
        if (command.includes("localhost:11434/api/tags")) return "";
        if (command.includes("localhost:1234/v1/models")) return "";
        if (command.includes("localhost:8000/v1/models")) return "";
        return "";
      },
      getSidecarImpl: () => ({
        label: "Ollama",
        start: (sandboxName) => started.push(sandboxName),
        waitForHealth: () => true,
        listModels: () => ["nemotron-3-nano:30b"],
        starterModels: [],
        getApiModelId: (model) => model,
        hasModel: () => true,
        downloadModelAsync: () => null,
      }),
    });

    try {
      const result = await selectInferenceProvider("selection-test", { type: "nvidia", perGpuMB: 16384 });
      expect(prompts[0]).toContain("Choose [1]:");
      expect(result.provider).toBe("ollama-k3s");
      expect(result.model).toBe("nemotron-3-nano:30b");
      expect(started).toEqual(["default"]);
    } finally {
      restore();
    }
  });

  it("defaults to sidecar on Linux GPU without EXPERIMENTAL flag", async () => {
    const prompts = [];
    const started = [];
    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      // No NEMOCLAW_EXPERIMENTAL set
      promptImpl: async (message) => {
        prompts.push(message);
        if (message.includes("Choose [")) return "";
        return "1";
      },
      runCaptureImpl: (command) => {
        if (command.includes("localhost:11434/api/tags")) return "";
        if (command.includes("localhost:1234/v1/models")) return "";
        if (command.includes("localhost:8000/v1/models")) return "";
        return "";
      },
      getSidecarImpl: () => ({
        label: "Ollama",
        start: (sandboxName) => started.push(sandboxName),
        waitForHealth: () => true,
        listModels: () => ["nemotron-3-nano:30b"],
        starterModels: [],
        getApiModelId: (model) => model,
        hasModel: () => true,
        downloadModelAsync: () => null,
      }),
    });

    try {
      // GPU with 24GB VRAM, above default 9600 MB threshold
      const result = await selectInferenceProvider("selection-test", { type: "nvidia", perGpuMB: 24576 });
      expect(result.provider).toBe("ollama-k3s");
      expect(result.model).toBe("nemotron-3-nano:30b");
      expect(prompts[0]).toContain("Choose [1]:");
    } finally {
      restore();
    }
  });

  it("defaults to cloud when GPU VRAM is below threshold", async () => {
    const prompts = [];
    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      promptImpl: async (message) => {
        prompts.push(message);
        return "";
      },
      runCaptureImpl: (command) => {
        if (command.includes("localhost:11434/api/tags")) return "";
        if (command.includes("localhost:1234/v1/models")) return "";
        if (command.includes("localhost:8000/v1/models")) return "";
        return "";
      },
    });

    try {
      // GPU with only 4GB VRAM — below 9600 MB threshold
      const result = await selectInferenceProvider("selection-test", { type: "nvidia", perGpuMB: 4096 });
      expect(result.provider).toBe("nvidia-nim");
    } finally {
      restore();
    }
  });

  it("defaults to cloud when no GPU is present", async () => {
    const prompts = [];
    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      promptImpl: async (message) => {
        prompts.push(message);
        return "";
      },
      runCaptureImpl: () => "",
    });

    try {
      const result = await selectInferenceProvider("selection-test", null);
      expect(result.provider).toBe("nvidia-nim");
    } finally {
      restore();
    }
  });

  it("respects custom VRAM threshold via env var", async () => {
    const started = [];
    const { selectInferenceProvider, restore } = loadSelectInferenceProvider({
      env: { NEMOCLAW_LOCAL_VRAM_THRESHOLD_MB: "30000" },
      promptImpl: async () => "",
      runCaptureImpl: (command) => {
        if (command.includes("localhost:11434/api/tags")) return "";
        if (command.includes("localhost:1234/v1/models")) return "";
        if (command.includes("localhost:8000/v1/models")) return "";
        return "";
      },
      getSidecarImpl: () => ({
        label: "Ollama",
        start: (sandboxName) => started.push(sandboxName),
        waitForHealth: () => true,
        listModels: () => ["nemotron-3-nano:30b"],
        starterModels: [],
        getApiModelId: (model) => model,
        hasModel: () => true,
        downloadModelAsync: () => null,
      }),
    });

    try {
      // 24GB GPU — above default 9600 but below custom 30000 threshold
      const result = await selectInferenceProvider("selection-test", { type: "nvidia", perGpuMB: 24576 });
      // Should fall back to cloud because 24576 < 30000
      expect(result.provider).toBe("nvidia-nim");
    } finally {
      delete process.env.NEMOCLAW_LOCAL_VRAM_THRESHOLD_MB;
      restore();
    }
  });
});
