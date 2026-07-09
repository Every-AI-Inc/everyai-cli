/**
 * Typed CLI error carrying a process exit code and a stable machine `code`.
 *
 * Throw a `CliError` from any command; the top-level handler in `index.ts`
 * renders it through the output envelope and exits with `exitCode`.
 */
export class CliError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
    public code = 'generic',
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
