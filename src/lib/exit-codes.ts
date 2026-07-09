/**
 * Stable process exit codes for the `every` CLI.
 *
 * These are part of the CLI CONTRACT — scripts, agents, and CI depend on them.
 * Do not renumber existing entries; only append new ones.
 */
export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  PERMISSION: 4,
  RATE_LIMIT: 5,
  NOT_FOUND: 6,
  NETWORK: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
