import { AnyFunction } from "./types.ts";

export function setMap<K, V>(map: { set(key: K, val: V): void; }, key: K, val: V) {
    map.set(key, val);
    return val;
}

/**
 * This class hides the implementation details of inheriting from Function in
 * the documentation.  (By default, typedoc exposes all the inherited properties
 * and members, which we don't want.  By inheriting from it instead of from
 * Function, we keep the documentation free of unimportant details.)
 */
//@ts-ignore CallableObject<T> adheres to the constraint of T in its *implementation*
export interface CallableObject<T extends AnyFunction> extends T {
    /** @internal */ [Symbol.hasInstance](value: any): boolean;
    /** @internal */ apply(this: Function, thisArg: any, argArray?: any): any;
    /** @internal */ bind(this: Function, thisArg: any, ...argArray: any[]): any;
    /** @internal */ call(this: Function, thisArg: any, ...argArray: any[]): any;
    /** @internal */ toString(): string;
}

export declare class CallableObject<T extends AnyFunction> extends Function {
    /** @internal */ protected constructor(fn: T);
    /** @internal */ declare length: number;
    /** @internal */ declare arguments: any;
    /** @internal */ declare caller: Function;
    /** @internal */ declare prototype: any;
    /** @internal */ declare name: string;
}

export function CallableObject<T>(fn: T) { return Object.setPrototypeOf(fn, new.target.prototype); }

// No need to have extra prototypes in the chain
CallableObject.prototype = Function.prototype as any;