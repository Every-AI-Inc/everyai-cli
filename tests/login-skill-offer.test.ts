import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  maybeOfferSkillAfterLogin,
  SkillOfferFileSystem,
} from '../src/commands/auth';
import type { HintsFile } from '../src/lib/hints';

function ttyInput(text: string, isTTY = true): Readable & { isTTY: boolean } {
  const stream = Readable.from([text]) as Readable & { isTTY: boolean };
  stream.isTTY = isTTY;
  return stream;
}

function outputCapture(isTTY = true): {
  output: Writable & { isTTY: boolean };
  text: () => string;
} {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { isTTY: boolean };
  output.isTTY = isTTY;
  return { output, text: () => chunks.join('') };
}

function fakeFileSystem(existingPaths: string[], initialHints: HintsFile = {}): {
  fileSystem: SkillOfferFileSystem;
  hints: () => HintsFile;
} {
  const existing = new Set(existingPaths);
  let hints = initialHints;
  return {
    fileSystem: {
      pathExists: vi.fn(async (filePath: string) => existing.has(filePath)),
      readHints: vi.fn(async () => hints),
      writeHints: vi.fn(async (next: HintsFile) => {
        hints = next;
      }),
    },
    hints: () => hints,
  };
}

describe('post-login skill offer', () => {
  it('choice 1 installs the project skill for Claude Code', async () => {
    const cwd = path.join(path.sep, 'workspace', 'company');
    const homeDir = path.join(path.sep, 'home', 'person');
    const input = ttyInput('1\n');
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fs = fakeFileSystem([path.join(cwd, '.claude')]);
    const installedTo = path.join(cwd, '.claude', 'skills', 'use-every');
    const installSkill = vi.fn(async () => ({ installed_to: installedTo }));

    await maybeOfferSkillAfterLogin({
      input,
      output: stdout.output,
      errorOutput: stderr.output,
      cwd,
      homeDir,
      fileSystem: fs.fileSystem,
      installSkill,
    });

    expect(installSkill).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledWith('claude');
    expect(stderr.text()).toContain(
      'Teach your coding agent to use Every? Install the use-every skill: [1] Claude Code [2] Codex [3] Both [Enter=skip]',
    );
    expect(stdout.text()).toContain(`to ${installedTo}`);
    expect(stdout.text()).toContain('commit it to share with your team');
  });

  it('Enter skips and records that the offer was declined', async () => {
    const cwd = path.join(path.sep, 'workspace', 'company');
    const homeDir = path.join(path.sep, 'home', 'person');
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fs = fakeFileSystem([path.join(cwd, '.agents')], { skill_hint_shown: true });
    const installSkill = vi.fn();

    await maybeOfferSkillAfterLogin({
      input: ttyInput('\n'),
      output: stdout.output,
      errorOutput: stderr.output,
      cwd,
      homeDir,
      fileSystem: fs.fileSystem,
      installSkill,
    });

    expect(installSkill).not.toHaveBeenCalled();
    expect(fs.hints()).toEqual({
      skill_hint_shown: true,
      skill_offer_declined: true,
    });
    expect(stdout.text()).toBe('');

    const laterStderr = outputCapture();
    await maybeOfferSkillAfterLogin({
      input: ttyInput('1\n'),
      output: stdout.output,
      errorOutput: laterStderr.output,
      cwd,
      homeDir,
      fileSystem: fs.fileSystem,
      installSkill,
    });
    expect(laterStderr.text()).toBe('');
    expect(installSkill).not.toHaveBeenCalled();
  });

  it('does not offer a skill already installed for the detected host', async () => {
    const cwd = path.join(path.sep, 'workspace', 'company');
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fs = fakeFileSystem([
      path.join(cwd, '.claude'),
      path.join(cwd, '.claude', 'skills', 'use-every'),
    ]);
    const installSkill = vi.fn();

    await maybeOfferSkillAfterLogin({
      input: ttyInput('1\n'),
      output: stdout.output,
      errorOutput: stderr.output,
      cwd,
      fileSystem: fs.fileSystem,
      installSkill,
    });

    expect(installSkill).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('');
  });

  it('never inspects or prompts when either required TTY is absent', async () => {
    for (const [stdinIsTTY, stdoutIsTTY] of [
      [false, true],
      [true, false],
    ]) {
      const stdout = outputCapture(stdoutIsTTY);
      const stderr = outputCapture();
      const fileSystem: SkillOfferFileSystem = {
        pathExists: vi.fn(),
        readHints: vi.fn(),
        writeHints: vi.fn(),
      };
      const installSkill = vi.fn();

      await maybeOfferSkillAfterLogin({
        input: ttyInput('1\n', stdinIsTTY),
        output: stdout.output,
        errorOutput: stderr.output,
        fileSystem,
        installSkill,
      });

      expect(fileSystem.readHints).not.toHaveBeenCalled();
      expect(installSkill).not.toHaveBeenCalled();
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toBe('');
    }
  });

  it('never inspects or prompts in JSON mode', async () => {
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fileSystem: SkillOfferFileSystem = {
      pathExists: vi.fn(),
      readHints: vi.fn(),
      writeHints: vi.fn(),
    };

    await maybeOfferSkillAfterLogin({
      json: true,
      input: ttyInput('1\n'),
      output: stdout.output,
      errorOutput: stderr.output,
      fileSystem,
      installSkill: vi.fn(),
    });

    expect(fileSystem.readHints).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('');
  });

  it('stays silent when prompting to a redirected process.stderr (not a TTY)', async () => {
    const fileSystem: SkillOfferFileSystem = {
      pathExists: vi.fn(),
      readHints: vi.fn(),
      writeHints: vi.fn(),
    };
    const stderrSpy = vi
      .spyOn(process, 'stderr', 'get')
      .mockReturnValue(outputCapture(false).output as typeof process.stderr);
    try {
      await maybeOfferSkillAfterLogin({
        input: ttyInput('1\n'),
        output: outputCapture().output,
        errorOutput: process.stderr,
        fileSystem,
        installSkill: vi.fn(),
      });
    } finally {
      stderrSpy.mockRestore();
    }

    expect(fileSystem.readHints).not.toHaveBeenCalled();
  });
});
