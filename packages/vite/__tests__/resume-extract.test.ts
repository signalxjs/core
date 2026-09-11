/**
 * @vitest-environment node
 *
 * extractResumeHandlers() — the analysis half of sigxResume() (#241):
 * QRL attribute injection, handler-module emission with capture rewrites,
 * eligibility classification, and symbol determinism.
 */

import { describe, it, expect } from 'vitest';
import { extractResumeHandlers, formMarkedImportsOf, hasDefaultAction, offsetToLoc } from '../src/resume-extract';

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
        // On an element with no native default — on a <form> submit it is
        // ineligible instead (see the preventDefault describe).
        const code = `
import { component } from 'sigx';
import { onSubmit } from './form';
export const Form = component((ctx) => {
    const dirty = ctx.signal(false);
    return () => <div onClick={onSubmit}>x</div>;
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

describe('preventDefault — unconditional stamps only', () => {
    const form = (handler: string) => extractResumeHandlers(`
import { component } from 'sigx';
export const F = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form onSubmit={${handler}}><input name="q" /></form>;
});
`, '/src/F.resume.tsx');

    it('stamps data-sigx-pd only for a top-level unconditional call', () => {
        const first = form('(e) => { e.preventDefault(); n.value++; }');
        expect(first.handlers[0].preventDefault).toBe(true);
        expect(first.code).toContain('data-sigx-pd:submit=""');
        expect(first.pdEvents).toEqual(['submit']);
        // After a harmless statement is still unconditional.
        const later = form('(e) => { const q = e.target; n.value++; e.preventDefault(); }');
        expect(later.handlers[0].preventDefault).toBe(true);
        // So are an expression body and an optional call.
        expect(form('(e) => e.preventDefault()').handlers[0].preventDefault).toBe(true);
        expect(form('(e) => { e?.preventDefault(); }').handlers[0].preventDefault).toBe(true);
    });

    it('a guarded call on an element with a native default is ineligible and stamps nothing', () => {
        const result = form('(e) => { if (n.value > 0) e.preventDefault(); n.value++; }');
        expect(result.components[0].mode).toBe('hydrate');
        expect(result.ineligible[0].reason).toContain('conditionally or indirectly');
        expect(result.ineligible[0].reason).toContain("<form>'s native submit default");
        // The stamp is applied on every event, upgraded or not — so hydrate
        // mode must not carry it either (it used to, and cancelled every submit).
        expect(result.code).not.toContain('data-sigx-pd');
        expect(result.pdEvents).toEqual([]);
    });

    it('an early return, throw or await before the call, a try, or a nested function makes it conditional', () => {
        for (const body of [
            '(e) => { if (!n.value) return; e.preventDefault(); }',
            '(e) => { if (!n.value) throw new Error("x"); e.preventDefault(); }',
            'async (e) => { await Promise.resolve(); e.preventDefault(); }',
            '(e) => { try { e.preventDefault(); } catch {} }',
            '(e) => { const go = () => e.preventDefault(); go(); }'
        ]) {
            expect(form(body).components[0].mode, body).toBe('hydrate');
        }
    });

    it('an alias, a destructured preventDefault, a method read, or the event passed to a helper is indirect', () => {
        const cases: Array<[string, string]> = [
            ['(e) => { const ev = e; ev.preventDefault(); }', 'aliased as `ev`'],
            ['({ preventDefault }) => { preventDefault(); }', 'destructured'],
            ['(e) => { const { preventDefault } = e; preventDefault(); }', 'destructured'],
            ['(e) => { const pd = e.preventDefault; pd.call(e); }', 'read off the event'],
            ['(e) => { cancel(e); n.value++; }', 'passed to `cancel(…)`']
        ];
        for (const [body, note] of cases) {
            const result = form(body);
            expect(result.components[0].mode, body).toBe('hydrate');
            expect(result.ineligible[0].reason, body).toContain(note);
        }
    });

    it('a guarded call on an element with no native default extracts without a stamp', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const D = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div onClick={(e) => { if (n.value) e.preventDefault(); n.value++; }}>x</div>;
});
`, '/src/D.resume.tsx');
        expect(result.components[0].mode).toBe('resume');
        expect(result.handlers[0].preventDefault).toBe(false);
        expect(result.code).not.toContain('data-sigx-pd');
    });

    it('an imported handler on a default-action element is ineligible — the call is invisible across modules', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { onSubmit } from './form';
export const Form = component((ctx) => {
    const dirty = ctx.signal(false);
    return () => <form onSubmit={onSubmit}>x</form>;
});
`, '/src/Form.resume.tsx');
        // It used to be wrapped: the form natively submitted on first interaction.
        expect(result.components[0].mode).toBe('hydrate');
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible[0].reason).toContain('imported from "./form"');
        expect(result.ineligible[0].reason).toContain('native submit default');
    });

    it('hasDefaultAction — the native-default table', () => {
        const attrs = (map: Record<string, string | null>) => (name: string) => (name in map ? map[name] : undefined);
        expect(hasDefaultAction('form', 'submit', attrs({}))).toBe(true);
        expect(hasDefaultAction('div', 'submit', attrs({}))).toBe(false);
        expect(hasDefaultAction('a', 'click', attrs({ href: '/x' }))).toBe(true);
        expect(hasDefaultAction('a', 'click', attrs({}))).toBe(false);
        expect(hasDefaultAction('button', 'click', attrs({}))).toBe(true);
        expect(hasDefaultAction('button', 'click', attrs({ type: 'button' }))).toBe(false);
        expect(hasDefaultAction('button', 'click', attrs({ type: null }))).toBe(true); // dynamic — might
        expect(hasDefaultAction('input', 'click', attrs({ type: 'checkbox' }))).toBe(true);
        expect(hasDefaultAction('input', 'click', attrs({ type: 'text' }))).toBe(false);
        expect(hasDefaultAction('input', 'click', attrs({}))).toBe(false);
        expect(hasDefaultAction('summary', 'click', attrs({}))).toBe(true);
        expect(hasDefaultAction('div', 'keydown', attrs({}))).toBe(true);
        expect(hasDefaultAction('div', 'click', attrs({}))).toBe(false);
        expect(hasDefaultAction('input', 'input', attrs({}))).toBe(false);
    });

    it('reads the element attributes the table needs: a typed button is default-free', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const B = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button type="button" onClick={(e) => { if (n.value) e.preventDefault(); n.value++; }}>x</button>;
});
`, '/src/B.resume.tsx');
        expect(result.components[0].mode).toBe('resume');
    });
});

describe('ctx.props is a serialized snapshot', () => {
    const handler = (body: string) => extractResumeHandlers(`
import { component } from 'sigx';
export const P = component<{ onSelect?: (id: number) => void; items: number[]; children?: unknown }>((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { ${body} }}>x</button>;
});
`, '/src/P.resume.tsx');

    it('calling a props member is ineligible — functions never serialize', () => {
        for (const body of ['ctx.props.onSelect(n.value);', 'ctx.props.onSelect?.(n.value);']) {
            const result = handler(body);
            expect(result.components[0].mode, body).toBe('hydrate');
            expect(result.ineligible[0].reason, body).toContain('calls ctx.props.onSelect');
            expect(result.ineligible[0].reason, body).toContain('functions never serialize');
        }
    });

    it('reading an on* prop is ineligible, directly or by destructuring', () => {
        for (const body of ['const cb = ctx.props.onSelect; n.value++;', 'const { onSelect } = ctx.props; n.value++;']) {
            const result = handler(body);
            expect(result.components[0].mode, body).toBe('hydrate');
            expect(result.ineligible[0].reason, body).toContain('onSelect');
            expect(result.ineligible[0].reason, body).toContain('never serialize');
        }
    });

    it('reading children / slots / ref / key / $models off props is ineligible', () => {
        for (const key of ['children', 'slots', 'ref', 'key', '$models']) {
            const result = handler(`console.log(ctx.props.${key}); n.value++;`);
            expect(result.components[0].mode, key).toBe('hydrate');
            expect(result.ineligible[0].reason, key).toContain('stripped from the props snapshot');
        }
    });

    it('plain data reads still rewrite to $scope.props', () => {
        const result = handler('n.value = ctx.props.items.length;');
        expect(result.components[0].mode).toBe('resume');
        expect(result.handlers[0].exportSource).toContain('$scope.props.items.length');
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

    it('rejects `this` in arrow handlers', () => {
        expect(firstReason(`
import { component } from 'sigx';
export const This = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value = this.x; }}>x</button>;
});
`)).toContain('this');
    });

    it('a handler binding or referencing $scope / $el is a build ERROR, not a hydrate downgrade (§4.5)', () => {
        // Parameter named $scope — a binding.
        const bound = extractResumeHandlers(`
import { component } from 'sigx';
export const Reserved = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={($scope) => { n.value++; }}>x</button>;
});
`, '/src/X.resume.tsx');
        expect(bound.errors).toHaveLength(1);
        expect(bound.errors[0].message).toContain('onclick of <Reserved>');
        expect(bound.errors[0].message).toContain('reserved name');
        // Not ALSO an ineligible: an error is not a warning.
        expect(bound.ineligible).toHaveLength(0);

        // A named signal called $el, read from the handler — a reference.
        const ref = extractResumeHandlers(`
import { component } from 'sigx';
export const RefEl = component((ctx) => {
    const $el = ctx.signal(0);
    return () => <button onClick={() => { $el.value++; }}>x</button>;
});
`, '/src/X.resume.tsx');
        expect(ref.errors).toHaveLength(1);
        expect(ref.errors[0].message).toContain('$el');
        // The offset points at the handler expression, for a file:line:col.
        expect(ref.errors[0].offset).toBe(ref.code.indexOf('() => { $el'));
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

    it('rejects generator handlers — re-emitted as an arrow, yield would not parse', () => {
        const reason = firstReason(`
import { component } from 'sigx';
export const Gen = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={function* () { n.value++; yield 1; }}>x</button>;
});
`);
        expect(reason).toContain('generator');
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

    it('a handler prop on a component tag is a build ERROR — delegation only sees host elements', () => {
        const code = `
import { component } from 'sigx';
import { Child } from './child.island';
export const Parent = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div>
        <Child onClick={() => { n.value++; }} />
    </div>;
});
`;
        const result = extractResumeHandlers(code, '/src/Parent.resume.tsx');
        // It used to stay silently in resume mode with a dead handler.
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('onclick of <Parent> is passed to <Child> as a component prop');
        expect(result.errors[0].message).toContain('never reaches the client');
        // Located at the attribute, like every §4.5 error.
        expect(result.errors[0].offset).toBe(code.indexOf('onClick={'));
    });

    it('names a member-expression component tag in the error', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import * as Ui from './ui';
export const Parent = component((ctx) => {
    return () => <Ui.Button onClick={() => { console.log('x'); }} />;
});
`, '/src/Parent.resume.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('passed to <Ui.Button>');
    });

    it('a namespaced tag is a host element — its handler is an ordinary site', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Icon = component((ctx) => {
    const n = ctx.signal(0);
    return () => <svg:rect onClick={() => { n.value++; }} />;
});
`, '/src/Icon.resume.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.handlers).toHaveLength(1);
        expect(result.code).toContain('data-sigx-on:click=');
    });

    it('a namespaced onUpdate:* attribute on a host element is ineligible with a reason', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Bound = component((ctx) => {
    const text = ctx.signal('');
    return () => <div>
        <input onUpdate:modelValue={(v) => { text.value = v; }} />
        <button onClick={() => { text.value = ''; }}>clear</button>
    </div>;
});
`, '/src/Bound.resume.tsx');
        // It used to be silently ignored — the QRL submit next to it read the
        // stale server value from $scope.signals.
        expect(result.errors).toHaveLength(0);
        expect(result.handlers).toHaveLength(0);
        expect(result.components[0].mode).toBe('hydrate');
        const miss = result.ineligible.find((m) => m.event === 'Update:modelValue')!;
        expect(miss.reason).toContain('not a DOM event');
        // The analyzable click still gets its wake attribute.
        expect(result.code).toContain('data-sigx-wake:click=""');
    });

    it('spread props on a host element are ineligible unless the spread is a handler-free object literal', () => {
        const spread = (expr: string, decl = '') => extractResumeHandlers(`
import { component } from 'sigx';
export const Spread = component((ctx) => {
    const n = ctx.signal(0);
    ${decl}
    return () => <button {...${expr}} onClick={() => { n.value++; }}>x</button>;
});
`, '/src/Spread.resume.tsx');

        const opaque = spread('ctx.props.attrs');
        expect(opaque.components[0].mode).toBe('hydrate');
        expect(opaque.ineligible[0].event).toBe('*');
        expect(opaque.ineligible[0].reason).toContain('spread props');

        // Handler-free literals are provably safe: inline, or a setup-scope const.
        expect(spread("{ class: 'x', title: 'y' }").components[0].mode).toBe('resume');
        expect(spread('extra', "const extra = { class: 'x' };").components[0].mode).toBe('resume');
        // …but a literal carrying a handler is not.
        expect(spread('{ onClick: () => {} }').components[0].mode).toBe('hydrate');
        expect(spread('extra', 'const extra = { onInput: () => {} };').components[0].mode).toBe('hydrate');
    });

    it('a hazard with no host-element handler site is a build ERROR on a boundary, nothing on a plain component', () => {
        const only = (view: string, signal = "const n = ctx.signal(0);") => extractResumeHandlers(`
import { component } from 'sigx';
export const Only = component((ctx) => {
    ${signal}
    return () => ${view};
});
`, '/src/Only.resume.tsx');
        // Named signals make it a boundary; with no wake carrier hydrate mode
        // would be just as dead as resume mode — so neither is offered.
        for (const view of [
            '<button {...ctx.props.attrs}>x</button>',
            "<input onUpdate:modelValue={(v) => { n.value = v; }} />"
        ]) {
            const result = only(view);
            expect(result.errors, view).toHaveLength(1);
            expect(result.errors[0].message, view).toContain('could never hydrate');
            expect(result.ineligible, view).toHaveLength(0);
        }
        // No signals and no handler: never stamped, so nothing to diagnose.
        const plain = only('<button {...ctx.props.attrs}>x</button>', '');
        expect(plain.errors).toHaveLength(0);
        expect(plain.ineligible).toHaveLength(0);
        expect(plain.components[0]).toMatchObject({ mode: 'resume', siteCount: 0, signalCount: 0 });
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

    it('skips a non-exported component silently (nothing outside can render it)', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
const Hidden = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export const useHidden = () => Hidden;
`, '/src/Hidden.resume.tsx');
        expect(result.components).toHaveLength(0);
        expect(result.handlers).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
    });

    // §4.5: a default-exported component used to be silently non-resumable.
    // All three spellings are a build error now.
    it('`export default Local` on a component is a build ERROR', () => {
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
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('resume components must be named exports');
        expect(result.errors[0].message).toContain('<Hidden>');
    });

    it('`export { Local as default }` on a component is a build ERROR', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
const Local = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export { Local as default };
`, '/src/Aliased.resume.tsx');
        expect(result.components).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('resume components must be named exports');
    });

    it('`export default component(...)` inline is a build ERROR', () => {
        const code = `
import { component } from 'sigx';
export default component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
`;
        const result = extractResumeHandlers(code, '/src/Inline.resume.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('export default component(...)');
        expect(result.errors[0].offset).toBe(code.indexOf('export default'));
    });

    it('a default export that is NOT a component is fine (resume/ dirs hold helpers too)', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Counter = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
const config = { step: 1 };
export default config;
`, '/src/Mixed.resume.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.components).toHaveLength(1);
        // And a named export ALSO aliased to default is still keyed by its name.
        const aliased = extractResumeHandlers(`
import { component } from 'sigx';
export const Counter = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export default Counter;
`, '/src/Both.resume.tsx');
        expect(aliased.errors).toHaveLength(0);
        expect(aliased.components.map((c) => c.exported)).toEqual(['Counter']);
        // …in either spelling and either order: the named export wins over
        // the default alias, it never overwrites the registry key.
        for (const tail of ['export { Counter as default };', '']) {
            for (const head of ['', 'export { Counter as default };']) {
                const both = extractResumeHandlers(`
import { component } from 'sigx';
${head}
export const Counter = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
${tail}
`, '/src/Both.resume.tsx');
                expect(both.errors).toHaveLength(0);
                expect(both.components.map((c) => c.exported)).toEqual(['Counter']);
            }
        }
    });
});

describe('offsetToLoc', () => {
    it('maps UTF-16 string indices to 1-based line/column', () => {
        const code = 'ab\ncd\nef';
        expect(offsetToLoc(code, 0)).toEqual({ line: 1, column: 1 });
        expect(offsetToLoc(code, 4)).toEqual({ line: 2, column: 2 });
        expect(offsetToLoc(code, 6)).toEqual({ line: 3, column: 1 });
    });
});

describe('generic signal declarations', () => {
    it('recognizes ctx.signal<T>(…) as a named signal', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Gen = component((ctx) => {
    const state = ctx.signal<{ a: number }>({ a: 1 });
    return () => <button onClick={() => { state.value = { a: 2 }; }}>x</button>;
});
`, '/src/Gen.resume.tsx');
        expect(result.components[0].signalCount).toBe(1);
        expect(result.handlers).toHaveLength(1);
        expect(result.handlers[0].exportSource).toContain('$scope.signals.state.value');
    });
});

describe('module-binding edge cases', () => {
    it('re-exports bind nothing locally', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export { Foo } from './other';
export const Own = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
`, '/src/Reexport.resume.tsx');
        // Only Own is a component of THIS module; Foo is not misregistered.
        expect(result.components.map((c) => c.exported)).toEqual(['Own']);
        expect(result.handlers).toHaveLength(1);
    });

    it('enum/namespace captures are module-local, not globals', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
enum Mode { A, B }
export const UsesEnum = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value = Mode.A; }}>x</button>;
});
`, '/src/Enum.resume.tsx');
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible[0].reason).toContain('"Mode"');
        expect(result.ineligible[0].reason).toContain('module-scope');
    });
});

describe('destructured slots consumption', () => {
    it('bails to hydrate mode for `const { slots } = ctx` too', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Destructured = component((ctx) => {
    const { slots } = ctx;
    const open = ctx.signal(false);
    return () => <div onClick={() => { open.value = true; }}>{slots.default()}</div>;
});
`, '/src/Destructured.resume.tsx');
        expect(result.components[0].mode).toBe('hydrate');
        expect(result.code).not.toContain('data-sigx-on:');
    });
});

describe('param-expression captures and aliased slots', () => {
    it('captures in default parameter initializers disqualify like body captures', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const ParamCapture = component((ctx) => {
    const n = ctx.signal(0);
    const helper = () => 1;
    return () => <button onClick={(e, step = helper()) => { n.value += step; }}>x</button>;
});
`, '/src/ParamCapture.resume.tsx');
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible[0].reason).toContain('"helper"');
    });

    it('aliased and rest destructuring of slots bail to hydrate mode', () => {
        for (const decl of ['const { slots: s } = ctx;', 'const { ...rest } = ctx;']) {
            const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Aliased = component((ctx) => {
    ${decl}
    const open = ctx.signal(false);
    return () => <div onClick={() => { open.value = true; }}>x</div>;
});
`, '/src/Aliased.resume.tsx');
            expect(result.components[0].mode).toBe('hydrate');
        }
    });
});

describe('setup-context parameter (§4.5)', () => {
    const CTX_MSG = 'resume components must take the setup context as a single identifier parameter';

    it('a destructured setup parameter is a build ERROR when the component has handler sites', () => {
        const code = `
import { component } from 'sigx';
export const Pattern = component<{ label: string }>(({ signal, props }) => {
    const count = signal(0);
    return () => <button onClick={() => { count.value++; }}>{props.label}</button>;
});
`;
        const result = extractResumeHandlers(code, '/src/Pattern.resume.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain(CTX_MSG);
        expect(result.errors[0].message).toContain('<Pattern>');
        expect(result.errors[0].offset).toBe(code.indexOf('{ signal, props }'));
        // Never silently extracted: `count` used to fall through as a "global"
        // and the element carried no data-sigx-b.
        expect(result.handlers).toHaveLength(0);
        expect(result.code).not.toContain('data-sigx-on:');
        expect(result.components).toHaveLength(0);
    });

    it('a missing setup parameter is a build ERROR when the component has handler sites', () => {
        const code = `
import { component } from 'sigx';
export const NoCtx = component(() => {
    return () => <button onClick={() => { console.log('hi'); }}>x</button>;
});
`;
        const result = extractResumeHandlers(code, '/src/NoCtx.resume.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain(CTX_MSG);
        expect(result.errors[0].message).toContain('declares none');
        expect(result.errors[0].offset).toBe(code.indexOf('() => {'));
        expect(result.handlers).toHaveLength(0);
    });

    it('a ctx-less component with no handler sites is left alone', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
export const Static = component(() => () => <p>static</p>);
`, '/src/Static.resume.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.components[0]).toMatchObject({ exported: 'Static', mode: 'resume', siteCount: 0 });
    });
});

describe('JSX in handler bodies (#283)', () => {
    it('is ineligible — the handlers chunk carries no jsx runtime', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { showToast } from './toast';
export const Toasty = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; showToast(<b>added</b>); }}>x</button>;
});
`, '/src/Toasty.resume.tsx');
        expect(result.handlers).toHaveLength(0);
        expect(result.ineligible[0].reason).toContain('JSX');
        expect(result.components[0].mode).toBe('hydrate');
    });
});

describe('zero-JS form actions — action/method stamping (rfc-server §6.4, #312)', () => {
    const KEY = 'app/api.server.ts/submitFeedback';
    // #355: the key's slashes are REAL path separators, so the
    // stamped action carries the key verbatim — no `%2F`, no `%23`.
    const ENCODED = KEY;
    const resolveServerFn = (specifier: string, exportName: string) =>
        specifier === './api.server' && exportName === 'submitFeedback'
            ? { key: KEY, form: true }
            : null;

    const FEEDBACK = (body: string) => `
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Feedback = component((ctx) => {
    const sent = ctx.signal(false);
    return () => (
        <form onSubmit={${body}}>
            <input name="message" required />
        </form>
    );
});
`;

    it('stamps action (stable symbol as real path segments) + method on the form', () => {
        const result = extractResumeHandlers(
            FEEDBACK(`async (e) => { e.preventDefault(); await submitFeedback({}); sent.value = true; }`),
            '/src/Feedback.tsx',
            { resolveServerFn }
        );
        expect(result.warnings).toHaveLength(0);
        expect(result.code).toContain(` action="/_sigx/fn/${ENCODED}" method="post"`);
        expect(result.code).toContain('data-sigx-pd:submit=""');
        expect(result.components[0].mode).toBe('resume');
    });

    it('FORCES data-sigx-pd:submit when the handler does not call preventDefault', () => {
        const result = extractResumeHandlers(
            FEEDBACK(`async () => { await submitFeedback({}); sent.value = true; }`),
            '/src/Feedback.tsx',
            { resolveServerFn }
        );
        expect(result.code).toContain(` action="/_sigx/fn/${ENCODED}" method="post"`);
        const pd = result.code.match(/data-sigx-pd:submit=""/g);
        expect(pd).toHaveLength(1);
    });

    /**
     * §6.4 stamps only in resume mode, so ONE unextractable capture demotes
     * the component to hydrate mode and the native action silently vanishes —
     * the generic "not resumable" warning says nothing about the form (#488).
     */
    it('warns when a hydrate-mode component drops its form action', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
const helper = () => 1;                    // module-local ⇒ ineligible capture
export const Feedback = component((ctx) => {
    return () => (
        <form onSubmit={async (e) => { e.preventDefault(); helper(); await submitFeedback({}); }}>
            <input name="message" />
        </form>
    );
});
`, '/src/Feedback.tsx', { resolveServerFn });

        expect(result.components[0].mode).toBe('hydrate');
        expect(result.code).not.toContain('action="/_sigx/fn/');
        expect(result.warnings.join("\n")).toMatch(/HYDRATE mode/);
        expect(result.warnings.join('\n')).toMatch(/without JS/);
    });

    it('stays quiet for a hydrate-mode component whose form targets nothing form-marked', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
const helper = () => 1;
export const Plain = component((ctx) => {
    return () => (
        <form onSubmit={(e) => { e.preventDefault(); helper(); }}>
            <input name="q" />
        </form>
    );
});
`, '/src/Plain.tsx', { resolveServerFn });

        expect(result.components[0].mode).toBe('hydrate');
        expect(result.warnings.join('\n')).not.toMatch(/HYDRATE mode/);
    });

    describe('formMarkedImportsOf — the out-of-include gate (#488)', () => {
        it('reports form-marked named imports', () => {
            expect(
                formMarkedImportsOf(FEEDBACK('() => submitFeedback({})'), '/src/Feedback.tsx', resolveServerFn)
            ).toEqual(['submitFeedback']);
        });

        it('reports nothing when the import is not form-marked', () => {
            expect(
                formMarkedImportsOf(FEEDBACK('() => submitFeedback({})'), '/src/Feedback.tsx',
                    () => ({ key: 'x', form: false }))
            ).toEqual([]);
        });

        it('ignores namespace, default and type-only imports — none can be a stamp target', () => {
            const code = `
import type { A } from './api.server';
import * as api from './api.server';
import def from './api.server';
export const X = () => null;
`;
            expect(formMarkedImportsOf(code, '/src/X.tsx', () => ({ key: 'x', form: true }))).toEqual([]);
        });
    });

    it('honors a custom endpoint', () => {
        const result = extractResumeHandlers(
            FEEDBACK(`() => submitFeedback({})`),
            '/src/Feedback.tsx',
            { resolveServerFn, endpoint: '/api/rpc' }
        );
        expect(result.code).toContain(` action="/api/rpc/${ENCODED}" method="post"`);
    });

    it('does not stamp without a resolver (no sigx:server plugin)', () => {
        const result = extractResumeHandlers(
            FEEDBACK(`() => submitFeedback({})`),
            '/src/Feedback.tsx'
        );
        expect(result.code).not.toContain('action=');
        // …and pd is not forced either — nothing changed vs today.
        expect(result.code).not.toContain('data-sigx-pd');
    });

    it('does not stamp when the serverFn is not form-marked (silent)', () => {
        const result = extractResumeHandlers(
            FEEDBACK(`() => submitFeedback({})`),
            '/src/Feedback.tsx',
            { resolveServerFn: () => ({ key: KEY, form: false }) }
        );
        expect(result.code).not.toContain('action=');
        expect(result.warnings).toHaveLength(0);
    });

    it('does not stamp a submit handler on a non-form element', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Odd = component((ctx) => {
    const n = ctx.signal(0);
    return () => <div onSubmit={() => submitFeedback({})}>x</div>;
});
`, '/src/Odd.tsx', { resolveServerFn });
        expect(result.code).not.toContain('action=');
    });

    it('does not stamp non-submit events on a form', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Odd = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form onClick={() => submitFeedback({})}>x</form>;
});
`, '/src/Odd.tsx', { resolveServerFn });
        expect(result.code).not.toContain('action=');
    });

    it('multiple form-marked captures are ambiguous — warning, no stamp', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback, submitOther } from './api.server';
export const Two = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form onSubmit={(e) => { e.preventDefault(); submitFeedback({}); submitOther({}); }}>x</form>;
});
`, '/src/Two.tsx', {
            resolveServerFn: (_spec, name) => ({ key: `app#${name}`, form: true })
        });
        expect(result.code).not.toContain('action=');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('ambiguous');
    });

    it('an author-written action/method wins — warning, no stamp', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Manual = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form action="/legacy" onSubmit={(e) => { e.preventDefault(); submitFeedback({}); }}>x</form>;
});
`, '/src/Manual.tsx', { resolveServerFn });
        expect(result.code).not.toContain('/_sigx/fn/');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('author-written');
    });

    it('two form-marked captures that resolve to the SAME symbol are not ambiguous', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
import { submitFeedback as again } from './api.server';
export const Dup = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form onSubmit={(e) => { e.preventDefault(); submitFeedback({}); again({}); }}>x</form>;
});
`, '/src/Dup.tsx', { resolveServerFn });
        expect(result.code).toContain(` action="/_sigx/fn/${ENCODED}" method="post"`);
        expect(result.warnings).toHaveLength(0);
    });
});

describe('form-action stamping — spread props and default imports (#312 review)', () => {
    it('spread props on the form are treated as author-provided — warning, no stamp', () => {
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Spread = component((ctx) => {
    const n = ctx.signal(0);
    const extra = { class: 'x' };
    return () => <form {...extra} onSubmit={(e) => { e.preventDefault(); submitFeedback({}); }}>x</form>;
});
`, '/src/Spread.tsx', {
            resolveServerFn: () => ({ key: 'app#submitFeedback', form: true })
        });
        expect(result.code).not.toContain('action=');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('spread props');
    });

    it('a default-imported serverFn is never a stamp target (not extracted server-side)', () => {
        const resolved: string[] = [];
        const result = extractResumeHandlers(`
import { component } from 'sigx';
import submitDefault from './api.server';
export const Def = component((ctx) => {
    const n = ctx.signal(0);
    return () => <form onSubmit={(e) => { e.preventDefault(); submitDefault({}); }}>x</form>;
});
`, '/src/Def.tsx', {
            resolveServerFn: (spec, name) => {
                resolved.push(`${spec}#${name}`);
                return { key: 'should-not-happen', form: true };
            }
        });
        expect(result.code).not.toContain('action=');
        // The resolver is never even consulted for default imports.
        expect(resolved).toHaveLength(0);
    });
});
