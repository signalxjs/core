#!/usr/bin/env node

/**
 * SignalX - Pre-publish pack smoke test
 *
 * Catches packaging bugs that lint/typecheck/test miss:
 *   - missing files in `files` array
 *   - broken `exports` map
 *   - unresolved `workspace:^` ranges
 *   - dist/ produced by stale builds
 *
 * What it does:
 *   1. Build all six publishable packages (delegates to `pnpm run build`).
 *   2. `pnpm pack` each package into a temp dir.
 *   3. Spin up a minimal scratch project with file: deps to those tarballs.
 *   4. Build it with vite to prove the published shape actually works.
 *
 * Usage:
 *   node scripts/verify-pack.js
 *
 * No flags. Exits non-zero on any failure.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const PACKAGES = [
    'packages/reactivity',
    'packages/runtime-core',
    'packages/runtime-dom',
    'packages/sigx',
    'packages/server-renderer',
    'packages/vite',
];

const sandbox = join(tmpdir(), `sigx-verify-pack-${Date.now()}`);
const tarballDir = join(sandbox, 'tarballs');
const appDir = join(sandbox, 'app');

function run(cmd, opts = {}) {
    console.log(`$ ${cmd}${opts.cwd ? `  (in ${opts.cwd})` : ''}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

function step(label) {
    console.log(`\n▶  ${label}`);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function packPackage(pkgPath) {
    const pkgFullPath = join(rootDir, pkgPath);
    const pkgJson = readJson(join(pkgFullPath, 'package.json'));
    const before = new Set(existsSync(pkgFullPath) ? readdirSync(pkgFullPath) : []);
    run('pnpm pack --pack-destination ' + JSON.stringify(tarballDir), { cwd: pkgFullPath });
    // Don't try to capture output — just find the newest tgz that matches the package name.
    const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz'));
    const safeName = pkgJson.name.replace('@', '').replace('/', '-');
    const match = tarballs.find((f) => f.startsWith(safeName));
    if (!match) {
        throw new Error(`Could not find tarball for ${pkgJson.name} in ${tarballDir}`);
    }
    return { name: pkgJson.name, version: pkgJson.version, tarball: join(tarballDir, match) };
}

function main() {
    step(`Sandbox: ${sandbox}`);
    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    step('Build all packages');
    run('pnpm run build', { cwd: rootDir });

    step('Pack each publishable package');
    const packed = PACKAGES.map(packPackage);
    for (const p of packed) {
        console.log(`   📦 ${p.name}@${p.version}  →  ${p.tarball}`);
    }

    step('Create scratch app');
    // Minimal vite + sigx app: import from `sigx`, render a counter, build with vite.
    const deps = Object.fromEntries(
        packed.map((p) => [p.name, `file:${p.tarball.replace(/\\/g, '/')}`])
    );
    const appPkg = {
        name: 'sigx-pack-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { build: 'vite build' },
        dependencies: deps,
        devDependencies: {
            vite: readJson(join(rootDir, 'package.json')).devDependencies.vite,
            typescript: readJson(join(rootDir, 'package.json')).devDependencies.typescript,
        },
    };
    writeFileSync(join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2));

    writeFileSync(
        join(appDir, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    jsx: 'react-jsx',
                    jsxImportSource: '@sigx/runtime-core',
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                },
                include: ['src'],
            },
            null,
            2
        )
    );

    writeFileSync(
        join(appDir, 'vite.config.ts'),
        `import { defineConfig } from 'vite';\nimport sigx from '@sigx/vite';\nexport default defineConfig({ plugins: [sigx()] });\n`
    );

    writeFileSync(
        join(appDir, 'index.html'),
        `<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`
    );

    mkdirSync(join(appDir, 'src'), { recursive: true });
    writeFileSync(
        join(appDir, 'src', 'main.tsx'),
        [
            "import { component, signal, render } from 'sigx';",
            '',
            'const Counter = component(() => {',
            '  const count = signal(0);',
            '  const form = signal({ name: \'\' });',
            '  return () => (',
            '    <div>',
            '      <button onClick={() => count.value++}>count: {count.value}</button>',
            '      <input model={[form, \'name\']} />',
            '      <p use:show={count.value > 0}>visible after first click</p>',
            '    </div>',
            '  );',
            '});',
            '',
            "render(<Counter />, document.getElementById('app')!);",
            '',
        ].join('\n')
    );

    // Also exercise SSR import path from the published @sigx/server-renderer tarball.
    writeFileSync(
        join(appDir, 'src', 'ssr-check.ts'),
        [
            "import { renderToString } from '@sigx/server-renderer/server';",
            "// Type-only smoke check that the named export is reachable from the published shape.",
            'export type _R = typeof renderToString;',
            '',
        ].join('\n')
    );

    step('Install scratch app (npm — to avoid pnpm workspace hoisting interference)');
    run('npm install --no-audit --no-fund --loglevel=error', { cwd: appDir });

    step('Build scratch app');
    run('npm run build', { cwd: appDir });

    step('Assert production build resolved the production dist (devtools/dev-warnings stripped)');
    const assetsDir = join(appDir, 'dist', 'assets');
    const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    if (bundles.length === 0) {
        throw new Error('Scratch app build produced no JS assets to inspect.');
    }
    const FORBIDDEN = ['__SIGX_DEVTOOLS_HOOK__', 'process.env.NODE_ENV', 'called outside of component setup'];
    // Platform side effects must SURVIVE tree-shaking: the scratch app uses
    // model={...} and use:show, so the DOM form model processor and the
    // auto-registered show directive (both reached via the sideEffects-listed
    // @sigx/runtime-dom/platform entry) must be in the bundle. Guards the
    // side-effect chain across bundlers.
    const REQUIRED = ['checkbox', 'sigx.show.originalDisplay'];
    const allContent = bundles.map((f) => readFileSync(join(assetsDir, f), 'utf-8'));
    for (let i = 0; i < bundles.length; i++) {
        for (const marker of FORBIDDEN) {
            if (allContent[i].includes(marker)) {
                throw new Error(
                    `Production bundle ${bundles[i]} contains "${marker}" — the production export condition ` +
                    'did not resolve to the .prod.js dist, or the prod dist is not fully stripped.'
                );
            }
        }
    }
    for (const marker of REQUIRED) {
        if (!allContent.some((c) => c.includes(marker))) {
            throw new Error(
                `No production bundle contains "${marker}" — the platform model processor was ` +
                'tree-shaken away; the @sigx/runtime-dom/platform side-effect chain is broken.'
            );
        }
    }
    console.log(`   ✔ ${bundles.length} bundle(s) clean and platform side effects retained`);

    step('✅ Pack smoke test passed');
}

try {
    main();
} catch (err) {
    console.error('\n❌ Pack smoke test failed:', err.message);
    console.error(`   Sandbox preserved for inspection: ${sandbox}`);
    process.exitCode = 1;
    process.exit(1);
}

// Best-effort cleanup on success only — leave the sandbox on failure for debugging.
try {
    rmSync(sandbox, { recursive: true, force: true });
} catch {
    // ignore
}
