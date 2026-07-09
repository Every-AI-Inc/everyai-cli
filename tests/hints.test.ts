import { describe, expect, it } from 'vitest';
import { skillHintForEnv } from '../src/lib/hints.js';

describe('coding-agent skill hint', () => {
  it('targets Claude Code when CLAUDECODE is set', () => {
    expect(skillHintForEnv({ CLAUDECODE: '1' })).toBe(
      'Tip: teach your coding agent this CLI — run: every skills install claude  (shown once)',
    );
  });

  it('targets Codex when any CODEX_-prefixed variable is set', () => {
    expect(skillHintForEnv({ CODEX_FOO: '1' })).toBe(
      'Tip: teach your coding agent this CLI — run: every skills install codex  (shown once)',
    );
  });

  it('keeps the generic command outside a detected agent host', () => {
    expect(skillHintForEnv({})).toBe(
      'Tip: teach your coding agent this CLI — run: every skills install claude|codex  (shown once)',
    );
  });
});
