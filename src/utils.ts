/**
 * Utilities that aren't part of Uneventful's core feature set, but are exposed
 * anyway, because they're boilerplate that can save duplication elsewhere if
 * you happen to need them.
 *
 * @module uneventful/utils
 */
import { AnyFunction } from "./types.ts";

/**
 * Helper for creating hybrid legacy/TC39 decorator/wrapper functions, e.g.:
 *
 * ```ts
 * // As wrapper function
 * export function myDecorator<T>(fn: SomeFnType<T>): SomeFnType<T>;
 *
 * // TC39 decorator
 * export function myDecorator<T>(fn: SomeFnType<T>, ctx: {kind: "method"}): SomeFnType<T>
 *
 * // "Legacy"/"TypeScript Experimental" Decorator
 * export function myDecorator<T,D extends {value?: SomeFnType<T>}>(clsOrProto:any, name: string|symbol, desc: D): D
 *
 * // Implementation
 * export function myDecorator<T>(factory: SomeFnType<T>, ...args: any[]): SomeFnType<T> {
 *     // extra args means we're being used as a decorator, so run as decorator:
 *     if (args.length) return decorateMethod(myDecorator, factory, ...args as [any, any]);
 *     // No extra args, we're b
 *     return () => {
 *     }
 * }
 * ```
 *
 * Yes, this is fairly ugly, but it's also the **only** way to make this work
 * when the wrapper is a generic function.  (TypeScript's type system doesn't
 * allow generic values, declaring functions as implementing interfaces,
 * higher-order kinds, or any other tricks that would let you avoid this giant
 * ball of boilerplate for generic decorators.)
 *
 * @category Functions and Decorators
 */
export function decorateMethod<F extends AnyFunction, D extends { value?: F; }>(
    decorate: (fn: F) => F, fn: F, _ctxOrName: string | symbol | { kind: "method"; }, desc?: D
): F | D {
    const method = decorate(desc ? desc.value : fn);
    return desc ? { ...desc, value: method } : method as F;
}

/**
 * Shorthand for Array.isArray()
 *
 * @category Data Structures
 * @function
 */
export const isArray = Array.isArray;

/**
 * Return true if the supplied parameters are the same object/value, or are
 * arrays with identical contents.
 *
 * @category Data Structures
 */
export function arrayEq<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined): boolean;
export function arrayEq<T>(a: any, b: any): boolean;
export function arrayEq<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined) {
    return (a===b) || (isArray(a) && isArray(b) && a.length === b.length && a.every(same, b))
}

function same(this: any[], item: any, idx:  number) { return item === this[idx]; }

/**
 * Set a value in a Map or WeakMap, and return the value.
 *
 * Commonly used with constructions like `return map.get(key) ?? setMap(map,
 * key, calculateDefault())`.
 *
 * @template K The type of key accepted by the map
 * @template V The type of value accepted by the map
 *
 * @category Data Structures
 */
export function setMap<K, V>(map: { set(key: K, val: V): void; }, key: K, val: V) {
    map.set(key, val);
    return val;
}

/**
 * Is the given value a function?  (Shorthand for `typeof f === "function"`)
 *
 * @category Functions and Decorators
 */
export function isFunction(f: any): f is Function {
    return typeof f === "function";
}

/**
 * A base class for creating callable objects.
 *
 * The way this works is that you subclass CallableObject and define a
 * constructor that calls `super(someClosure)` where `someClosure` is a *unique*
 * function object, which will then pick up any properties or methods defined by
 * the subclass.
 *
 * (Note: It needs to be unique because the `super()` call only sets its
 * prototype, and returns the function you passed as `this`.  So if you call it
 * with the same function more than once, you're just reinitializing the same
 * object instead of creating a new one.)
 *
 * @template T The call/return signature that instances of the class will
 * implement.
 *
 * @param fn A unique function or closure, to be passed to super() in a
 * subclass.  The function object will gain a prototype from `new.target`,
 * thereby picking up any properties or methods defined by the class, and
 * becoming `this` for the calling constructor.
 *
 * (Note that calling the constructor by any means other than super() from a
 * constructor will result in an error or some other unhelpful result.)
 *
 * @category Functions and Decorators
 */
export const CallableObject: new <T extends AnyFunction>(fn: T) => T = /* @__PURE__ */ (() => {
    function CallableObject<T>(fn: T) { return Object.setPrototypeOf(fn, new.target.prototype); }
    CallableObject.prototype = Function.prototype;
    return CallableObject as any
})();


export { batch, type Batch } from "./scheduling.ts";

/**
 * Calls the `target` function with the given object as the `this` value and the
 * elements of given array as the arguments.  (Shorthand for Reflect.apply)
 *
 * @category Functions and Decorators
 * @function
 */
export const apply = Reflect.apply;

/**
 * Like `fn.call(thisArg, ...args)`, but monomorphic, and the `thisArg`
 * parameter can be omitted or null.
 *
 * This is mostly useful as syntax sugar for an immediately-evaluated function
 * expression, replacing `(() => {...})()` with `call(() => {...})`.
 *
 * @category Functions and Decorators
 */
export function call<F extends AnyFunction>(
    fn: F, thisArg?: ThisParameterType<F>, ...args: Parameters<F>
): ReturnType<F> {
    return thisArg ? apply(fn, thisArg, args) : (args.length ? fn(...args) : fn());
}

/**
 * A pseudo-constructor for the abstract ancestor type of all generators,
 * useful for testing whether something is `instanceof Generator`.
 *
 * @category Data Structures
 * @class
 */
export const GeneratorBase = /* @__PURE__ */ (() => {
    function G() {}; G.prototype = (function *(){}).constructor.prototype.prototype;
    return G as any as abstract new () => Generator;
})()

/**
 * Is the given function a native generator function?
 *
 * @category Functions and Decorators
 */
export function isGeneratorFunction<G extends Generator<any,any,any>=Generator>(
    fn: any
): fn is (this: any, ...args: any[]) => G {
    return isFunction(fn) && fn.prototype instanceof GeneratorBase
}
