// Keep install-detection tests independent of the developer's global skills.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
if (!process.env.EVERY_TEST_HOME) throw new Error('Missing isolated test home');
os.homedir = () => process.env.EVERY_TEST_HOME;
syncBuiltinESMExports();
