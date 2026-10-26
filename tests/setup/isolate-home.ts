import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tests must never read or write the developer's real home directory.
 *
 * The CLI looks for installed agent skills under ~/.claude, ~/.codex and
 * ~/.agents, and `every signup`/`every login` refresh outdated copies there.
 * Pointing HOME at a throwaway directory (inherited by spawned CLI processes,
 * which copy process.env) keeps a test run from rewriting a real install and
 * keeps results independent of what happens to be installed on the machine.
 */
const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'everyai-cli-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
