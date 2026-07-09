import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runFirstRunMenu } from '../src/lib/first-run';

function input(text: string): Readable {
  return Readable.from([text]);
}

function outputCapture(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(''),
  };
}

describe('first-run menu', () => {
  it('choice 2 shows help without logging in', async () => {
    const capture = outputCapture();
    const showHelp = vi.fn();
    const login = vi.fn();

    await runFirstRunMenu({
      input: input('2\n'),
      output: capture.output,
      showHelp,
      login,
      getStatus: async () => ({ logged_in: false }),
      getCachedIdentity: async () => undefined,
    });

    expect(capture.text()).toContain("Welcome to Every AI — you're not logged in.");
    expect(showHelp).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  it('choice 3 exits without help or login', async () => {
    const capture = outputCapture();
    const showHelp = vi.fn();
    const login = vi.fn();

    await runFirstRunMenu({
      input: input('3\n'),
      output: capture.output,
      showHelp,
      login,
      getStatus: async () => ({ logged_in: false }),
      getCachedIdentity: async () => undefined,
    });

    expect(showHelp).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('Enter invokes login by default', async () => {
    const capture = outputCapture();
    const showHelp = vi.fn();
    const menuInput = input('\n');
    const login = vi.fn(async () => {
      expect(menuInput.listenerCount('data')).toBe(0);
    });

    await runFirstRunMenu({
      input: menuInput,
      output: capture.output,
      showHelp,
      login,
      getStatus: async () => ({ logged_in: false }),
      getCachedIdentity: async () => undefined,
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(showHelp).not.toHaveBeenCalled();
  });

  it('logged-in users get cached identity status and help', async () => {
    const capture = outputCapture();
    const showHelp = vi.fn(() => capture.output.write('HELP\n'));
    const login = vi.fn();

    await runFirstRunMenu({
      input: input(''),
      output: capture.output,
      showHelp,
      login,
      getStatus: async () => ({ logged_in: true }),
      getCachedIdentity: async () => ({ email: 'person@example.com', org_name: 'Acme Co' }),
    });

    expect(capture.text()).toContain('Logged in as person@example.com · org Acme Co · try: every tools list');
    expect(capture.text()).toContain('HELP');
    expect(showHelp).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });
});
