import { describe, it, expect, vi } from 'vitest';
import { effectScope, effect, signal } from '../src/index';

describe('effectScope', () => {
    describe('basic behavior', () => {
        it('should run a function within the scope', () => {
            const scope = effectScope();
            let value = 0;

            scope.run(() => {
                value = 42;
            });

            expect(value).toBe(42);
        });

        it('should return the result of the run function', () => {
            const scope = effectScope();
            const result = scope.run(() => 'hello');
            expect(result).toBe('hello');
        });

        it('should not run after stop()', () => {
            const scope = effectScope();
            scope.stop();

            const result = scope.run(() => 'hello');
            expect(result).toBeUndefined();
        });
    });

    describe('effect management', () => {
        it('should group multiple effects together', () => {
            const state = signal({ count: 0 });
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            
            const scope = effectScope();
            
            scope.run(() => {
                effect(() => {
                    fn1(state.count);
                });
                effect(() => {
                    fn2(state.count * 2);
                });
            });
            
            expect(fn1).toHaveBeenCalledWith(0);
            expect(fn2).toHaveBeenCalledWith(0);
            
            state.count = 5;
            expect(fn1).toHaveBeenCalledWith(5);
            expect(fn2).toHaveBeenCalledWith(10);
        });

        it('should allow effects to run independently within scope', () => {
            const state = signal({ a: 1, b: 2 });
            const fnA = vi.fn();
            const fnB = vi.fn();
            
            const scope = effectScope();
            
            scope.run(() => {
                effect(() => {
                    fnA(state.a);
                });
                effect(() => {
                    fnB(state.b);
                });
            });
            
            // Only fnA should re-run when a changes
            state.a = 10;
            expect(fnA).toHaveBeenCalledTimes(2);
            expect(fnB).toHaveBeenCalledTimes(1);
            
            // Only fnB should re-run when b changes
            state.b = 20;
            expect(fnA).toHaveBeenCalledTimes(2);
            expect(fnB).toHaveBeenCalledTimes(2);
        });
    });

    describe('scope lifecycle', () => {
        it('should allow multiple runs on the same scope', () => {
            const scope = effectScope();
            let counter = 0;
            
            scope.run(() => { counter += 1; });
            scope.run(() => { counter += 10; });
            scope.run(() => { counter += 100; });
            
            expect(counter).toBe(111);
        });

        it('should reject all runs after stop', () => {
            const scope = effectScope();
            let counter = 0;
            
            scope.run(() => { counter = 1; });
            expect(counter).toBe(1);
            
            scope.stop();
            
            scope.run(() => { counter = 999; });
            expect(counter).toBe(1); // Should not have changed
        });
    });

    describe('nested scopes', () => {
        it('should allow creating nested effect scopes', () => {
            const state = signal({ count: 0 });
            const outerFn = vi.fn();
            const innerFn = vi.fn();
            
            const outerScope = effectScope();
            let innerScope: ReturnType<typeof effectScope> | undefined;
            
            outerScope.run(() => {
                effect(() => {
                    outerFn(state.count);
                });
                
                innerScope = effectScope();
                innerScope.run(() => {
                    effect(() => {
                        innerFn(state.count);
                    });
                });
            });
            
            state.count = 1;
            expect(outerFn).toHaveBeenCalledWith(1);
            expect(innerFn).toHaveBeenCalledWith(1);
            
            // Stop inner scope - inner effect should no longer run
            innerScope!.stop();
            
            state.count = 2;
            expect(outerFn).toHaveBeenCalledWith(2);
            // Inner effect no longer tracks
        });
    });
});
