// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * renderBox — render content lines inside a Unicode box.
 *
 * Each entry in `lines` is either a pre-assembled content string or `null`
 * for a blank separator row. The inner width is computed as:
 *
 *   min(terminal_cols - 4, max(minInner, longest_line + 2))
 *
 * The `-4` accounts for the two-space indent and the `│` border on each side.
 * This ensures the box never overflows the terminal regardless of content length.
 */
export function renderBox(
  lines: (string | null)[],
  { minInner = 53 }: { minInner?: number } = {},
): string[] {
  const termCols = Math.max(60, Number(process.stdout.columns || 100));
  const maxInner = termCols - 4;
  const contentMax = lines.reduce<number>(
    (m, l) => (l === null ? m : Math.max(m, l.length + 2)),
    minInner,
  );
  const inner = Math.min(maxInner, contentMax);
  const pad = (s: string) => s + " ".repeat(Math.max(0, inner - s.length));
  const hBar = "─".repeat(inner);
  const blank = " ".repeat(inner);

  return [
    `  ┌${hBar}┐`,
    ...lines.map((l) => (l === null ? `  │${blank}│` : `  │${pad(l)}│`)),
    `  └${hBar}┘`,
  ];
}
