import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Tests run against package sources, which use the `__DEV__` compile-time
// flag. A static `define` won't do here: Vite substitutes
// `process.env.NODE_ENV` inside define values at transform time, freezing the
// flag, while several suites flip NODE_ENV at runtime to exercise production
// branches. A global getter keeps the lookup dynamic per access.
Object.defineProperty(globalThis, '__DEV__', {
    configurable: true,
    get: () => process.env.NODE_ENV !== 'production'
});

// Hand the suite a REAL temp path (#512). Two dozen tests build real Vite
// projects in `mkdtempSync(join(tmpdir(), …))` roots, and on macOS `tmpdir()`
// is `/var/folders/…`, a symlink to `/private/var/folders/…`. Vite resolves
// module ids through the filesystem while `config.root` stays as given, so the
// two spellings never meet: `vite:build-html` emits a path that escapes the
// root ("must be strings that are neither absolute nor relative paths"), and
// seven build tests fail on macOS while passing in CI — a suite that is only
// green on Linux is a suite nobody trusts.
//
// One assignment instead of a helper at 22 call sites: `os.tmpdir()` reads
// these variables on every call, so every existing and future test gets a real
// path with nothing to remember. It does NOT paper over the product bug of the
// same origin — plugins resolve their own root (`resolveRoot`, islands.ts), and
// `symlink-root.test.ts` builds through a deliberate symlink to prove it.
const realTmp = realpathSync.native(tmpdir());
process.env.TMPDIR = realTmp;   // POSIX
process.env.TEMP = realTmp;     // Windows
process.env.TMP = realTmp;
