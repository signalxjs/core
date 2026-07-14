// Edge-runtime import guard (rfc-ssr-platform §2.3): the smoke test runs the
// BUILT production dist through the Web-stream document path with every Node
// builtin import forbidden — the module-graph property a WinterCG runtime
// (workerd, Deno Deploy, …) enforces for real. Any `node:*` (or bare
// builtin) import reaching the guarded graph fails the run.
import { builtinModules } from 'node:module';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export function resolve(specifier, context, nextResolve) {
    if (BUILTINS.has(specifier)) {
        throw new Error(
            `[edge-smoke] Node builtin "${specifier}" imported on the edge path ` +
            `(from ${context.parentURL ?? 'entry'}) — the '.'/'./server' entries ` +
            `must stay WinterCG-clean; Node-only code belongs in '@sigx/server-renderer/node'.`
        );
    }
    return nextResolve(specifier, context);
}
