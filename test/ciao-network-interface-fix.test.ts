// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("ciao network-interface fix preload (NemoClaw#2414)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _CIAO_FIX_SCRIPT path variable", () => {
    expect(src).toContain('_CIAO_FIX_SCRIPT="/tmp/nemoclaw-ciao-network-fix.js"');
  });

  it("embeds the fix via a CIAO_FIX_EOF heredoc", () => {
    expect(src).toMatch(
      /emit_sandbox_sourced_file\s+"\$_CIAO_FIX_SCRIPT"\s+<<'CIAO_FIX_EOF'/,
    );
    expect(src).toMatch(/^CIAO_FIX_EOF$/m);
  });

  it("registers the preload in NODE_OPTIONS", () => {
    expect(src).toContain(
      'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_CIAO_FIX_SCRIPT"',
    );
  });

  it("includes the preload in the proxy-env sourced file for connect sessions", () => {
    expect(src).toMatch(/# ciao mDNS network-interface fix for connect sessions/);
    expect(src).toContain("--require $_CIAO_FIX_SCRIPT");
  });

  it("passes the preload path to validate_tmp_permissions in both root and non-root branches", () => {
    const calls =
      src.match(/validate_tmp_permissions[^\n]*"\$_CIAO_FIX_SCRIPT"/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("preload is scoped to OPENSHELL_SANDBOX=1", () => {
    const heredoc = src.match(/<<'CIAO_FIX_EOF'\n([\s\S]*?)\nCIAO_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc![1];
    expect(script).toContain("OPENSHELL_SANDBOX");
    expect(script).toContain("!== '1'");
    expect(script).toContain("return");
  });

  it("preload wraps os.networkInterfaces with a try-catch returning {}", () => {
    const heredoc = src.match(/<<'CIAO_FIX_EOF'\n([\s\S]*?)\nCIAO_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc![1];
    expect(script).toContain("os.networkInterfaces");
    expect(script).toContain("try {");
    expect(script).toContain("catch (_e)");
    expect(script).toContain("return {};");
  });

  it("preload calls the original os.networkInterfaces on the success path", () => {
    const heredoc = src.match(/<<'CIAO_FIX_EOF'\n([\s\S]*?)\nCIAO_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc![1];
    expect(script).toContain("origNetworkInterfaces");
    expect(script).toContain("return origNetworkInterfaces()");
  });

  it("preload is placed after the WebSocket fix in the script", () => {
    const wsPos = src.indexOf("_WS_FIX_SCRIPT=");
    const ciaoPos = src.indexOf("_CIAO_FIX_SCRIPT=");
    expect(wsPos).toBeGreaterThan(-1);
    expect(ciaoPos).toBeGreaterThan(-1);
    expect(ciaoPos).toBeGreaterThan(wsPos);
  });

  it("preload is placed before the proxy-env file section", () => {
    const ciaoPos = src.indexOf("_CIAO_FIX_SCRIPT=");
    const proxyEnvPos = src.indexOf("_PROXY_ENV_FILE=");
    expect(ciaoPos).toBeGreaterThan(-1);
    expect(proxyEnvPos).toBeGreaterThan(-1);
    expect(ciaoPos).toBeLessThan(proxyEnvPos);
  });
});
