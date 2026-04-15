// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderBox } from "./banner.js";

describe("renderBox", () => {
  // lines[0] is "  ┌" + hBar + "┐", so length - 4 = inner width
  const innerWidth = (lines: string[]) => lines[0].length - 4;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns top border, content lines, and bottom border", () => {
    const lines = renderBox(["  Hello"]);
    expect(lines[0]).toMatch(/^  ┌─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^  └─+┘$/);
    expect(lines).toHaveLength(3); // top + 1 content + bottom
  });

  it("respects default minInner of 53", () => {
    expect(innerWidth(renderBox(["  short"]))).toBeGreaterThanOrEqual(53);
  });

  it("respects a custom minInner", () => {
    expect(innerWidth(renderBox(["  hi"], { minInner: 20 }))).toBeGreaterThanOrEqual(20);
  });

  it("renders null entries as blank box lines", () => {
    const lines = renderBox([null]);
    expect(lines[1]).toMatch(/^  │ +│$/);
  });

  it("all lines have equal length — box is aligned", () => {
    const lines = renderBox(["  short", null, "  a much longer line here"]);
    const lengths = lines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it("expands inner width to fit a long content line", () => {
    const longLine = "  " + "x".repeat(80);
    const [, contentLine] = renderBox([longLine], { minInner: 53 });
    expect(contentLine).toContain(longLine);
    expect(contentLine.startsWith("  │")).toBe(true);
    expect(contentLine.endsWith("│")).toBe(true);
  });

  it("caps inner width at terminal columns minus 4", () => {
    vi.spyOn(process.stdout, "columns", "get").mockReturnValue(70);
    const veryLongLine = "  " + "x".repeat(200);
    const [topBorder] = renderBox([veryLongLine]);
    expect(topBorder.length - 4).toBeLessThanOrEqual(66); // 70 - 4
  });

  it("falls back to 100-column width when stdout.columns is undefined", () => {
    vi.spyOn(process.stdout, "columns", "get").mockReturnValue(
      undefined as unknown as number,
    );
    const veryLongLine = "  " + "x".repeat(200);
    const [topBorder] = renderBox([veryLongLine]);
    expect(topBorder.length - 4).toBeLessThanOrEqual(96); // 100 - 4
  });

  it("does not throw when content exceeds capped inner width", () => {
    vi.spyOn(process.stdout, "columns", "get").mockReturnValue(40);
    expect(() => renderBox(["  " + "x".repeat(100)])).not.toThrow();
  });

  it("always provides at least 2 trailing spaces before the closing border", () => {
    // Core invariant of the PR: padEnd(fixed) was the bug. The +2 in contentMax
    // guarantees inner >= longestLine.length + 2 for every line in the box.
    // Mock columns so the test is deterministic regardless of terminal width.
    vi.spyOn(process.stdout, "columns", "get").mockReturnValue(120);
    const url = "https://abc-defgh-ijklmn-opqr.trycloudflare.com";
    const urlLine = "  Public URL:  " + url;
    const lines = renderBox([urlLine]);
    const contentLine = lines[1];
    // Strip the "  │" prefix and "│" suffix, then check trailing spaces
    const content = contentLine.slice(3, -1);
    expect(content.endsWith("  ")).toBe(true);
  });
});
