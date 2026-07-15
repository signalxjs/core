/**
 * @vitest-environment node
 *
 * extractResumeHandlers() — the analysis half of sigxResume() (#241):
 * QRL attribute injection, handler-module emission with capture rewrites,
 * eligibility classification, and symbol determinism.
 */

import { describe, it, expect } from 'vitest';
import { extractResumeHandlers, offsetToLoc } from '../src/resume-extract';

const COUNTER = `
import { component } from 'sigx';

export const Counter = component<{ label: string }>((ctx) => {
    const count = ctx.signal(0);
    return () => (
        <button onClick={(e) => { count.value++; }}>
            {ctx.props.label}: {count.value}
        </button>
    );
});
`;

describe('extractResumeHandlers — basics', () => {
    it('extracts an inline arrow, rewrites signal captures, injects attributes', () => {
        const result = extractResumeHandlers(COUNTER, '/src/Counter.resume.tsx');

        expect(result.handlers).toHaveLength(1);
        const handler = result.handlers[0];
        expect(handler.event).toBe('click');
        expect(handler.component).toBe('Counter');
        expect(handler.symbol).toMatch(/^Counter_click_[0-9a-f]{8}$/);
        expect(handler.exportSource).toBe(
            `export const ${handler.symbol} = ($scope, e) => { $scope.signals.count.value++; };`
        );

        // Original onClick kept; QRL + boundary attributes appended after it.
        expect(result.code).toContain(`onClick={(e) => { count.value++; }} data-sigx-on:click="${handler.symbol}"`);
        expect(result.code).toContain('data-sigx-b={ctx.$sigxB}');
        expect(result.code).not.toContain('data-sigx-pd');

        expect(result.components).toEqual([
            { local: 'Counter', exported: 'Counter', mode: 'resume', handlerCount: 1, siteCount: 1, signalCount: 1 }
        ]);
        expect(result.events).toEqual(['click']);
        expect(result.handlersModule).toContain(handler.exportSource);
    });

    it('rewrites ctx.props reads and flags preventDefault', () => {
        const code = `
import { component } from 'sigx';
export const Link = component<{ href: string }>((ctx) => {
    return () => <a href="#" onClick={(e) => { e.preventDefault(); console.log(ctx.props.href); }}>go</a>;
});
`;
        const result = extractResumeHandlers(code, '/src/Link.resume.tsx');
        expect(result.handlers).toHaveLength(1);
        expect(result.handlers[0].preventDefault).toBe(true);
        expect(result.handlers[0].exportSource).toContain('console.log($scope.props.href)');
        expect(result.code).toContain('data-sigx-pd:click=""');
    });

    it('flags preventDefault only on the event parameter', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { controller } from './ctl';
export const NotPd = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div>
        <button onClick={(e) => { controller.preventDefault(); n.value++; }}>a</button>
        <button onClick={(ev) => { ev.preventDefault(); n.value++; }}>b</button>
    </div>;
});
`, '/src/NotPd.resume.tsx');
        expect(result.handlers).toHaveLength(2);
        const bySymbolPd = result.handlers.map((h) => h.preventDefault);
        expect(bySymbolPd).toEqual([false, true]);
        expect(result.code.split('data-sigx-pd:click').length - 1).toBe(1);
    });

    it('replicates multiple default imports from one source as separate statements', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import foo from './x';
import bar from './x';
export const Multi = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value = foo() + bar(); }}>x</button>;
});
`, '/src/Multi.resume.tsx');
        expect(result.handlersModule).toContain(`import foo from "./x";`);
        expect(result.handlersModule).toContain(`import bar from "./x";`);
    });

    it('replicates imports from other modules into the handlers module', () => {
        const code = `
import { component } from 'sigx';
import { track, flush as flushNow } from './analytics';
import logger from './logger';
export const Button = component((ctx) => {
    const hits = ctx.signal(0);
    return () => <button onClick={() => { hits.value++; track('hit'); flushNow(); logger.info('x'); }}>go</button>;
});
`;
        const result = extractResumeHandlers(code, '/src/Button.resume.tsx');
        expect(result.handlers).toHaveLength(1);
        expect(result.handlersModule).toContain(`import { track, flush as flushNow } from "./analytics";`);
        expect(result.handlersModule).toContain(`import logger from "./logger";`);
        expect(result.handlersModule).not.toContain('sigx');
    });

    it('wraps an imported-identifier handler', () => {
        const code = `
import { component } from 'sigx';
import { onSubmit } from './form';
export const Form = component((ctx) => {
    const dirty = ctx.signal(false);
    return () => <form onSubmit={onSubmit}>x</form>;
});
`;
        const result = extractResumeHandlers(code, '/src/Form.resume.tsx');
        expect(result.handlers).toHaveLength(1);
        expect(result.handlers[0].exportSource).toContain('($scope, ...$args) => onSubmit(...$args)');
        expect(result.handlersModule).toContain(`import { onSubmit } from "./form";`);
    });

    it('extracts a setup-scope const handler and async handlers', () => {
        const code = `
import { component } from 'sigx';
export const Saver = component((ctx) => {
    const saved = ctx.signal(false);
    const save = async () => { await fetch('/save'); saved.value = true; };
    return () => <button onClick={save}>save</button>;
});
`;
        const result = extractResumeHandlers(code, '/src/Saver.resume.tsx');
        expect(result.handlers).toHaveLength(1);
        expect(result.handlers[0].exportSource).toContain('async ($scope)');
        expect(result.handlers[0].exportSource).toContain('$scope.signals.saved.value = true');
        expect(result.components[0].mode).toBe('resume');
    });

    it('is idempotent — already-stamped events are not extracted again', () => {
        const first = extractResumeHandlers(COUNTER, '/src/Counter.resume.tsx');
        const second = extractResumeHandlers(first.code, '/src/Counter.resume.tsx');
        expect(second.code).toBe(first.code);
        expect(second.handlers).toHaveLength(0);
        expect(second.ineligible).toHaveLength(0);
    });

    it('dedupes identical handlers to one symbol', () => {
        const code = `
import { component } from 'sigx';
export const Twins = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div>
        <button onClick={() => { n.value++; }}>a</button>
        <button onClick={() => { n.value++; }}>b</button>
    </div>;
});
`;
        const result = extractResumeHandlers(code, '/src/Twins.resume.tsx');
        expect(result.handlers).toHaveLength(1);
        const occurrences = result.code.split(`data-sigx-on:click="${result.handlers[0].symbol}"`).length - 1;
        expect(occurrences).toBe(2);
    });

    it('emits data-sigx-b once per element, even with two handled events', () => {
        const code = `
import { component } from 'sigx';
export const Multi = component((ctx) => {
    const n = ctx.signal(0);
    return () => <input onFocus={() => { n.value++; }} onInput={() => { n.value--; }} />;
});
`;
        const result = extractResumeHandlers(code, '/src/Multi.resume.tsx');
        expect(result.handlers).toHaveLength(2);
        expect(result.events).toEqual(['focus', 'input']);
        expect(result.code.split('data-sigx-b=').length - 1).toBe(1);
    });
});

describe('extractResumeHandlers — eligibility', () => {
    function firstReason(code: string): string {
        const result = extractResumeHandlers(code, '/src/X.resume.tsx');
        expect(result.ineligible.length).toBeGreaterThan(0);
        expect(result.components[0]?.mode).toBe('hydrate');
        return result.ineligible[0].reason;
    }

    it('rejects view-scope captures (loop variables)', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const List = component((ctx) => {
    const sel = ctx.signal(0);
    return () => <ul>{[1, 2].map((item) => <li onClick={() => { sel.value = item; }}>x</li>)}</ul>;
});
`);
        expect(reason).toContain('"item"');
        expect(reason).toContain('view-scope');
    });

    it('rejects same-file module-scope captures', () => {
        const reason = firstReason(`
import { component } from 'sigx';
const STEP = 2;
export const Stepper = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value += STEP; }}>x</button>;
});
`);
        expect(reason).toContain('"STEP"');
        expect(reason).toContain('module-scope');
    });

    it('rejects ctx.emit and other non-props ctx use', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Emitter = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => ctx.emit('picked', n.value)}>x</button>;
});
`);
        expect(reason).toContain('ctx.emit');
    });

    it('rejects setup-scope locals that are not named signals', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Helper = component((ctx) => {
    const n = ctx.signal(0);
    const bump = (by) => { n.value += by; };
    return () => <button onClick={() => bump(2)}>x</button>;
});
`);
        expect(reason).toContain('"bump"');
    });

    it('rejects non-function handler expressions (.bind, calls)', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Bound = component((ctx) => {
    const n = ctx.signal(0);
    const f = function () { n.value++; };
    return () => <button onClick={f.bind(null)}>x</button>;
});
`);
        expect(reason).toContain('statically analyzable');
    });

    it('rejects reassignment of the signal binding itself', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Reassign = component((ctx) => {
    let n = ctx.signal(0);
    return () => <button onClick={() => { n = null; }}>x</button>;
});
`);
        // `let n = ctx.signal(…)` is still a named signal per SIGNAL_DECL_RE.
        expect(reason).toContain('reassigns');
    });

    it('rejects `this` in arrow handlers and reserved names', () => {
        expect(firstReason(`
import { component } from 'sigx';
export const This = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value = this.x; }}>x</button>;
});
`)).toContain('this');

        expect(firstReason(`
import { component } from 'sigx';
export const Reserved = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={($scope) => { n.value++; }}>x</button>;
});
`)).toContain('reserved');
    });

    it('allows reserved names in non-reference positions (keys, member props)', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Keys = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={(e) => { n.value = ({ $scope: 1 }).$scope + (e.target as any).$el; }}>x</button>;
});
`, '/src/Keys.resume.tsx');
        expect(result.ineligible).toHaveLength(0);
        expect(result.handlers).toHaveLength(1);
    });

    it('does not resolve a setup const through a shadowing view-scope binding', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Shadow = component((ctx) => {
    const n = ctx.signal(0);
    const save = () => { n.value++; };
    return () => {
        const save = () => { window.name = 'view-closure'; };
        return <button onClick={save}>x</button>;
    };
});
`, '/src/Shadow.resume.tsx');
        // The identifier refers to the VIEW-scope `save`; resolving it to the
        // setup const would extract the wrong function.
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible).toHaveLength(1);
        expect(result.components[0].mode).toBe('hydrate');
    });

    it('rejects `this`/`arguments` even in function-expression handlers (re-emitted as arrows)', () => {
        expect(firstReason(`
import { component } from 'sigx';
export const FnThis = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={function () { n.value = (this as any).x; }}>x</button>;
});
`)).toContain('this');

        expect(firstReason(`
import { component } from 'sigx';
export const FnArgs = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={function () { n.value = arguments.length; }}>x</button>;
});
`)).toContain('arguments');
    });

    it('allows `this`/`arguments` owned by functions nested inside the handler', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Nested = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { const f = function () { return this; }; n.value++; }}>x</button>;
});
`, '/src/Nested.resume.tsx');
        expect(result.ineligible).toHaveLength(0);
        expect(result.handlers).toHaveLength(1);
    });

    it('rejects destructuring-assignment writes to captured bindings', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Destructure = component((ctx) => {
    let n = ctx.signal(0);
    return () => <button onClick={(e) => { ({ n } = e.target as any); }}>x</button>;
});
`);
        expect(reason).toContain('reassigns');
    });

    it('rejects writes to ctx.props', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const PropsWrite = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { ctx.props.count = n.value; }}>x</button>;
});
`);
        expect(reason).toContain('read-only');
    });

    it('mixed eligibility is all-or-nothing: wake attributes only, no QRL exports', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
const STEP = 2;
export const Mixed = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div>
        <button onClick={(e) => { e.preventDefault(); n.value++; }}>fine</button>
        <button onClick={() => { n.value += STEP; }}>ineligible</button>
    </div>;
});
`, '/src/Mixed.resume.tsx');
        // The eligible handler must NOT get a live QRL — the hydrated
        // component's real listener would double-dispatch its events.
        expect(result.handlers).toHaveLength(0);
        expect(result.handlersModule).toBeNull();
        expect(result.code).not.toContain('data-sigx-on:');
        expect(result.code.split('data-sigx-wake:click=""').length - 1).toBe(2);
        // pd analysis still applies to analyzable-but-unextracted handlers.
        expect(result.code.split('data-sigx-pd:click=""').length - 1).toBe(1);
        expect(result.code.split('data-sigx-b=').length - 1).toBe(2);
        expect(result.events).toEqual(['click']);
        expect(result.components[0]).toEqual({
            local: 'Mixed', exported: 'Mixed', mode: 'hydrate', handlerCount: 0, siteCount: 2, signalCount: 1
        });
    });

    it('bails the whole component to hydrate mode when it consumes slots', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Wrapper = component((ctx) => {
    const open = ctx.signal(false);
    return () => <div onClick={() => { open.value = true; }}>{ctx.slots.default()}</div>;
});
`, '/src/Wrapper.resume.tsx');
        // The handler was analyzable, but a slots consumer cannot
        // data-remount — all-or-nothing: wake attributes only.
        expect(result.handlers).toHaveLength(0);
        expect(result.code).toContain('data-sigx-wake:click=""');
        expect(result.code).not.toContain('data-sigx-on:');
        expect(result.components[0].mode).toBe('hydrate');
    });

    it('ignores component-tag props and namespaced on* attributes', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { Child } from './child.island';
export const Parent = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div>
        <Child onClick={() => { n.value++; }} />
        <input onUpdate:modelValue={() => { n.value++; }} />
    </div>;
});
`, '/src/Parent.resume.tsx');
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible).toHaveLength(0);
        expect(result.components[0].mode).toBe('resume');
    });
});

describe('extractResumeHandlers — determinism', () => {
    const TWO = `
import { component } from 'sigx';
export const Two = component((ctx) => {
    const a = ctx.signal(0);
    const b = ctx.signal(0);
    return () => <div>
        <button onClick={() => { a.value++; }}>a</button>
        <input onInput={() => { b.value++; }} />
    </div>;
});
`;

    it('produces identical symbols across independent runs (client vs ssr env)', () => {
        const one = extractResumeHandlers(TWO, '/src/Two.resume.tsx');
        const two = extractResumeHandlers(TWO, '/src/Two.resume.tsx');
        expect(one.handlers.map((h) => h.symbol)).toEqual(two.handlers.map((h) => h.symbol));
        expect(one.code).toBe(two.code);
    });

    it('editing one handler leaves the other symbol unchanged', () => {
        const before = extractResumeHandlers(TWO, '/src/Two.resume.tsx');
        const after = extractResumeHandlers(TWO.replace('b.value++', 'b.value--'), '/src/Two.resume.tsx');
        const clickBefore = before.handlers.find((h) => h.event === 'click');
        const clickAfter = after.handlers.find((h) => h.event === 'click');
        const inputBefore = before.handlers.find((h) => h.event === 'input');
        const inputAfter = after.handlers.find((h) => h.event === 'input');
        expect(clickAfter!.symbol).toBe(clickBefore!.symbol);
        expect(inputAfter!.symbol).not.toBe(inputBefore!.symbol);
    });
});

describe('extractResumeHandlers — non-matches', () => {
    it('returns the source untouched for files without sigx components', () => {
        const code = `export const helper = () => 42;\n`;
        const result = extractResumeHandlers(code, '/src/util.resume.ts');
        expect(result.code).toBe(code);
        expect(result.handlersModule).toBeNull();
        expect(result.components).toHaveLength(0);
    });

    it('skips non-exported and default-exported components', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
const Hidden = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export default Hidden;
`, '/src/Hidden.resume.tsx');
        expect(result.components).toHaveLength(0);
        expect(result.handlers).toHaveLength(0);
    });
});

describe('offsetToLoc', () => {
    it('maps byte offsets to 1-based line/column', () => {
        const code = 'ab\ncd\nef';
        expect(offsetToLoc(code, 0)).toEqual({ line: 1, column: 1 });
        expect(offsetToLoc(code, 4)).toEqual({ line: 2, column: 2 });
        expect(offsetToLoc(code, 6)).toEqual({ line: 3, column: 1 });
    });
});
