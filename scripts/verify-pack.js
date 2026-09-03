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
 *   1. Build the publishable packages (delegates to `pnpm run build`).
 *   2. `pnpm pack` each package into a temp dir — every package in
 *      scripts/packages.js, the same list publish.js ships (#363).
 *   3. Read each tarball's package.json and FAIL if any dependency range is
 *      still `workspace:` / `catalog:` — such a manifest is uninstallable for
 *      every consumer the moment it reaches the registry.
 *   4. Spin up a minimal scratch project with file: deps to those tarballs.
 *   5. Build it with vite to prove the published shape actually works, and
 *      import every server-side entry under Node (dev + production
 *      conditions) to prove the export maps resolve at runtime.
 *
 * Usage:
 *   node scripts/verify-pack.js
 *
 * No flags. Exits non-zero on any failure.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync } from 'zlib';
import { PACKAGES, rootDir, assertPackagesComplete, findUnresolvedRanges } from './packages.js';

/**
 * [specifier, named export] — the entries the scratch-app bundle cannot reach
 * (server / Node / tooling), imported under Node instead. Covers the three
 * packages verify-pack used to skip (#363): @sigx/resume's server + client +
 * loader entries and its @sigx/vite transform, @sigx/server's ./server,
 * ./node, ./client and root entries, and @sigx/cache.
 */
const NODE_ENTRIES = [
    ['@sigx/server-renderer/server', 'renderToString'],
    ['@sigx/resume', 'resumePlugin'],
    ['@sigx/resume/server', 'createBoundaryRefresh'],
    ['@sigx/resume/client', 'resolveQrl'],
    ['@sigx/resume/loader', 'initResume'],
    ['@sigx/cache', 'cachePlugin'],
    ['@sigx/server', 'serverFn'],
    ['@sigx/server/server', 'createServerApp'],
    ['@sigx/server/node', 'createServerFnHandler'],
    ['@sigx/server/client', 'configureServerFn'],
    ['@sigx/server/plugin', 'serverPlugin'],
    ['@sigx/vite/resume', 'sigxResume'],
    ['@sigx/vite/server', 'sigxServer'],
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

/** Read a NUL-terminated field out of a 512-byte tar header. */
function tarField(header, start, length) {
    const raw = header.subarray(start, start + length).toString('utf-8');
    const nul = raw.indexOf('\0');
    return nul === -1 ? raw : raw.slice(0, nul);
}

/**
 * Pull `package/package.json` out of a packed tarball without shelling out to
 * `tar` (not on every Windows PATH) or adding a dependency. A tar stream is a
 * sequence of 512-byte headers each followed by the entry's data padded to a
 * 512-byte boundary; two zero blocks end it. npm/pnpm pack always root the
 * archive at `package/`.
 */
function readPackageJsonFromTarball(tarball) {
    const buf = gunzipSync(readFileSync(tarball));
    let offset = 0;
    while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const name = tarField(header, 0, 100);
        const prefix = tarField(header, 345, 155);
        const size = parseInt(tarField(header, 124, 12).trim() || '0', 8);
        const typeflag = header[156];
        const path = prefix ? `${prefix}/${name}` : name;
        const dataStart = offset + 512;
        // typeflag '0' or NUL = regular file (skip pax/long-name pseudo entries).
        if (path === 'package/package.json' && (typeflag === 0x30 || typeflag === 0)) {
            return JSON.parse(buf.subarray(dataStart, dataStart + size).toString('utf-8'));
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    throw new Error(`${tarball}: no package/package.json entry in the tarball`);
}

/**
 * The manifest that reaches the registry is the one INSIDE the tarball, not
 * the one on disk — pnpm rewrites `workspace:^` on the way in, so this is the
 * only place the rewrite can be checked. Throws on the first dirty package,
 * listing every offending range.
 */
function assertRangesResolved(packed) {
    for (const p of packed) {
        const manifest = readPackageJsonFromTarball(p.tarball);
        if (manifest.name !== p.name) {
            throw new Error(`${p.tarball}: tarball manifest is ${manifest.name}, expected ${p.name}`);
        }
        const dirty = findUnresolvedRanges(manifest);
        if (dirty.length > 0) {
            const lines = dirty.map((d) => `${d.field}.${d.name} = ${JSON.stringify(d.range)}`);
            throw new Error(
                `${p.name}@${p.version} would publish with unresolved ranges — ` +
                `a consumer cannot install it:\n     ${lines.join('\n     ')}`
            );
        }
    }
}

function main() {
    step(`Sandbox: ${sandbox}`);
    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    step('Build all packages');
    run('pnpm run build', { cwd: rootDir });

    step('Pack each publishable package');
    // The list is shared with publish.js and cross-checked against packages/*
    // on disk, so nothing publishable can escape verification again (#363).
    assertPackagesComplete();
    const packed = PACKAGES.map(packPackage);
    for (const p of packed) {
        console.log(`   📦 ${p.name}@${p.version}  →  ${p.tarball}`);
    }

    step('Assert every packed manifest has workspace:/catalog: ranges resolved');
    assertRangesResolved(packed);
    console.log(`   ✔ ${packed.length} tarball manifests clean`);

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
            "import { component, signal, defineApp } from 'sigx';",
            // The two client-installed packs ride the same app: their browser
            // entries must resolve from the tarballs and bundle cleanly.
            "import { cachePlugin } from '@sigx/cache';",
            "import { serverPlugin } from '@sigx/server/plugin';",
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
            'defineApp(<Counter />)',
            '  .use(cachePlugin({ staleTime: 30_000 }))',
            '  .use(serverPlugin())',
            "  .mount(document.getElementById('app')!);",
            '',
        ].join('\n')
    );

    // Every server-side / tooling entry, imported for real under Node from the
    // installed tarballs — vite never type-checks, so a type-only reference
    // would prove nothing. Each entry must resolve through its export map AND
    // expose the named export, under both the dev and production conditions.
    writeFileSync(
        join(appDir, 'smoke-entries.mjs'),
        [
            'const ENTRIES = [',
            ...NODE_ENTRIES.map(([spec, named]) => `  [${JSON.stringify(spec)}, ${JSON.stringify(named)}],`),
            '];',
            'for (const [spec, named] of ENTRIES) {',
            '  const mod = await import(spec);',
            '  if (typeof mod[named] === "undefined") {',
            '    throw new Error(`${spec}: named export "${named}" missing from the published shape`);',
            '  }',
            '}',
            'console.log(`   ✔ ${ENTRIES.length} entries resolved`);',
            '',
        ].join('\n')
    );

    step('Install scratch app (npm — to avoid pnpm workspace hoisting interference)');
    run('npm install --no-audit --no-fund --loglevel=error', { cwd: appDir });

    step('Build scratch app');
    run('npm run build', { cwd: appDir });

    step('Import every server-side entry under Node (default + production conditions)');
    run('node smoke-entries.mjs', { cwd: appDir });
    run('node --conditions production smoke-entries.mjs', { cwd: appDir });

    step('Assert production build resolved the production dist (devtools/dev-warnings stripped)');
    const assetsDir = join(appDir, 'dist', 'assets');
    const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    if (bundles.length === 0) {
        throw new Error('Scratch app build produced no JS assets to inspect.');
    }
    const FORBIDDEN = ['__SIGX_DEVTOOLS_HOOK__', 'process.env.NODE_ENV', 'called outside of component setup'];
    // Platform side effects must SURVIVE tree-shaking: the scratch app uses
    // model={...} and use:show, both served by @sigx/runtime-dom's platform
    // side-effect chunk (model processor + built-in directive registration
    // live in the SAME chunk by construction). The show directive's Symbol
    // description is the marker because it is unique to that chunk —
    // protocol strings like 'checkbox'/'radio'/'onUpdate:modelValue' also
    // appear in patchProp and would mask a dropped chunk.
    const REQUIRED = [
        {
            marker: 'sigx.show.originalDisplay',
            what: 'the @sigx/runtime-dom platform side-effect chunk (model processor + built-in directives)'
        }
    ];
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
    for (const { marker, what } of REQUIRED) {
        if (!allContent.some((c) => c.includes(marker))) {
            throw new Error(
                `No production bundle contains "${marker}" — ${what} was tree-shaken away; ` +
                'the sideEffects-listed platform entry/chunk chain is broken.'
            );
        }
    }
    console.log(`   ✔ ${bundles.length} bundle(s) clean and platform side effects retained`);

    // -----------------------------------------------------------------------
    // Scratch app #2 (rfc-deploy §3.1/§6): the BUNDLED edge build from real
    // tarballs — cloudflare() from the packed @sigx/cloudflare, the platform
    // entry scaffolded by the adapter itself, wrangler.jsonc generated, and
    // the bundled server output provably prod + node:-free.
    // -----------------------------------------------------------------------
    step('Create cloudflare scratch app (bundled edge build)');
    const cfDir = join(sandbox, 'app-cf');
    mkdirSync(join(cfDir, 'src'), { recursive: true });
    writeFileSync(join(cfDir, 'package.json'), JSON.stringify({
        name: 'sigx-pack-smoke-cf',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { build: 'vite build --app' },
        dependencies: deps,
        devDependencies: appPkg.devDependencies,
    }, null, 2));
    writeFileSync(join(cfDir, 'tsconfig.json'), readFileSync(join(appDir, 'tsconfig.json')));
    writeFileSync(
        join(cfDir, 'vite.config.ts'),
        [
            "import { defineConfig } from 'vite';",
            "import sigx from '@sigx/vite';",
            "import { cloudflare } from '@sigx/cloudflare';",
            'export default defineConfig({',
            "  plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: cloudflare() } })]",
            '});',
            '',
        ].join('\n')
    );
    writeFileSync(
        join(cfDir, 'index.html'),
        `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div><script type="module" src="/src/entry-client.tsx"></script></body></html>\n`
    );
    writeFileSync(join(cfDir, 'src', 'entry-client.tsx'), `console.log('client');\n`);
    writeFileSync(
        join(cfDir, 'src', 'entry-server.tsx'),
        [
            "import { component } from 'sigx';",
            'const Page = component(() => {',
            "  return () => <main>pack-smoke-cf</main>;",
            '});',
            'export function createApp(_url: string) {',
            '  return <Page />;',
            '}',
            '',
        ].join('\n')
    );
    // Deliberately NO src/entry.cloudflare.ts — the adapter's setup() hook
    // must scaffold it from the real tarball.

    step('Install cloudflare scratch app');
    run('npm install --no-audit --no-fund --loglevel=error', { cwd: cfDir });

    step('Build cloudflare scratch app (vite build --app)');
    run('npm run build', { cwd: cfDir });

    step('Assert the adapter scaffolded + generated, and the bundle is provably prod');
    if (!existsSync(join(cfDir, 'src', 'entry.cloudflare.ts'))) {
        throw new Error('cloudflare(): setup() did not scaffold src/entry.cloudflare.ts from the tarball.');
    }
    if (!existsSync(join(cfDir, 'wrangler.jsonc'))) {
        throw new Error('cloudflare(): generate() did not write wrangler.jsonc.');
    }
    const wrangler = readJson(join(cfDir, 'wrangler.jsonc'));
    if (wrangler.main !== 'dist/server/entry.cloudflare.js') {
        throw new Error(`wrangler.jsonc main is ${wrangler.main} — expected dist/server/entry.cloudflare.js`);
    }
    const serverDir = join(cfDir, 'dist', 'server');
    const serverBundles = readdirSync(serverDir).filter((f) => f.endsWith('.js'));
    if (!serverBundles.includes('entry.cloudflare.js')) {
        throw new Error(`Bundled build did not produce entry.cloudflare.js (got: ${serverBundles.join(', ')})`);
    }
    for (const f of serverBundles) {
        const content = readFileSync(join(serverDir, f), 'utf-8');
        // Fresh regex per file — a shared /g regex carries lastIndex across
        // iterations and silently skips matches.
        const importRe = /(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g;
        for (const marker of FORBIDDEN) {
            if (content.includes(marker)) {
                throw new Error(
                    `Bundled server output ${f} contains "${marker}" — the production condition did not ` +
                    'resolve to the .prod.js dist inside the edge bundle.'
                );
            }
        }
        for (let m = importRe.exec(content); m; m = importRe.exec(content)) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('/')) continue;
            if (/^cloudflare:/.test(spec)) continue;
            throw new Error(
                `Bundled server output ${f} still imports "${spec}" — the edge bundle must be ` +
                'self-contained (node: and bare imports forbidden beyond runtimeExternal).'
            );
        }
    }
    console.log(`   ✔ scaffolded entry + wrangler.jsonc + ${serverBundles.length} self-contained prod server bundle(s)`);

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
