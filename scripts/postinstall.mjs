#!/usr/bin/env node

try {
  process.stdout.write(
    [
      '@everyai/cli installed.',
      '- Command: every (also available as everyai)',
      '- Get started: every login',
      '- Teach agents: every skills install claude|codex',
      '- One-shot docs: every docs',
      '',
    ].join('\n'),
  );
} catch {
  // Installing this package must never fail because of a notice.
} finally {
  process.exit(0);
}
