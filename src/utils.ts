/**
 * Utilities that aren't part of Uneventful's core feature set, but are exposed
 * anyway, because they're boilerplate that can save duplication elsewhere if
 * you happen to need them.
 *
 * @module uneventful/utils
 */
import { AnyFunction } from "./types.ts";

/**
 * Shorthand for Array.isArray()
 *
 * @category Data Structures
 */
export const isArray = Array.isArray;

/**
 * Return true if the supplied parameters are the same object/vaue, or are
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
 * @category Functional Programming
 */
export function isFunction(f: any): f is Function {
    return typeof f === "function";
}

/**
 * This class hides the implementation details of inheriting from Function in
 * the documentation.  (By default, typedoc exposes all the inherited properties
 * and members, which we don't want.  By inheriting from it instead of from
 * Function, we keep the documentation free of unimportant details.)
 *
 * The way this works is that you subclass CallableObject and define a
 * constructor that calls `super(someClosure)` where `someClosure` is a unique
 * function object, which will then pick up any properties or methods defined by
 * the subclass.
 *
 * @template T The call/return signature that instances of the class will
 * implement.
 *
 * @category Functional Programming
 */
//@ts-ignore not really a duplicate
export declare class CallableObject<T extends AnyFunction> extends Function {
    /**
     * @param fn A unique function or closure, to be passed to super() in a
     * subclass.  The function object will gain a prototype from `new.target`,
     * thereby picking up any properties or methods defined by the class,
     * and becoming `this` for the calling constructor.
     *
     * (Note that calling the constructor by any means other than super() from
     * a constructor will result in an error or some other unhelpful result.)
     */
    constructor(fn: T);
    /** @internal */ declare length: number;
    /** @internal */ declare arguments: any;
    /** @internal */ declare caller: Function;
    /** @internal */ declare prototype: any;
    /** @internal */ declare name: string;
}
//@ts-ignore CallableObject<T> adheres to the constraint of T in its *implementation*
export interface CallableObject<T extends AnyFunction> extends T {
    /** @internal */ [Symbol.hasInstance](value: any): boolean;
    /** @internal */ apply(this: Function, thisArg: any, argArray?: any): any;
    /** @internal */ bind(this: Function, thisArg: any, ...argArray: any[]): any;
    /** @internal */ call(this: Function, thisArg: any, ...argArray: any[]): any;
    /** @internal */ toString(): string;
}
//@ts-ignore This is the real implementation of the above declarations
export const CallableObject = /* @__PURE__ */ ( () => <typeof CallableObject> Object.assign(
    function CallableObject<T>(fn: T) { return Object.setPrototypeOf(fn, new.target.prototype); },
    {prototype: Function.prototype }  // No need to have extra prototypes in the chain
))();

export { batch, type Batch } from "./scheduling.ts";

/**
 * Calls the `target` function with the given object as the `this` value and the
 * elements of given array as the arguments.
 *
 * @category Functional Programming
 */
export const apply = Reflect.apply;

/**
 * A pseudo-constructor for the abstract ancestor type of all generators,
 * useful for testing whether something is `instanceof Generator`.
 *
 * @category Data Structures
 */
export const GeneratorBase = /* @__PURE__ */ (() => {
    function G() {}; G.prototype = (function *(){}).constructor.prototype.prototype;
    return G as any as abstract new () => Generator;
})()
