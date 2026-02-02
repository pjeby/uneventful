/**
 * This module provides helpers for creating *extensions*: a way of extending
 * objects with additional (possibly private) data or methods via a WeakMap.
 *
 * An extension property links a type of object (known as the "target") with a
 * specific type of extension, via a factory function or class.  When you use an
 * extension property for a specific target, the extension is automatically
 * created (via the factory) if it doesn't already exist.
 *
 * Extension properties and methods are created either by inheriting from the
 * {@link Ext} class, or by wrapping factory functions with {@link ext}() or
 * {@link method}().
 *
 * @module uneventful/ext
 *
 * @disableGroups
 * @summary Tools for extending objects with extra state and behavior, without
 * directly modifying them.
 */

import { PlainFunction } from "./types.ts";
import { setMap } from "./utils.ts";

/**
 * Create an extension accessor function that returns a memoized
 * value for a given target object or function.
 *
 * (Memoization is done via WeakMap, so the cached extensions will be freed
 * automatically once the target is garbage-collected.)
 *
 * @template Target The type of target object that will be extended.  Both the
 * passed-in factory function and the returned accessor function will take a
 * parameter of this type, which must be an object or function type.  (So it's
 * suitable for weak referencing.)
 *
 * @template ExtType The type of extension that will be cached.  Both the
 * passed-in factory function and the returned accessor will return a value of
 * this type.
 *
 * @param factory Function called with a target object or function and a weakmap
 * to create a new extension for that target.  The result is cached in the
 * weakmap so the factory is called at most once per target (unless you alter
 * the weakmap contents directly).
 *
 * @param map Optional: the weakmap to use to store the extensions.  This allows
 * you to manipulate the map contents (e.g. remove items or clear it) from
 * outside the factory function.  If no map is provided, one is created
 * automatically, but then it's only accessible via the factory function's
 * second parameter.
 *
 * @returns A function that always returns the same extension for a given target
 * (assuming you don't alter the WeakMap), calling the factory function if an
 * extension doesn't exist yet for that target.
 */
export function ext<Target extends WeakKey, ExtType extends Object>(
    factory: (tgt: Target, map: WeakMap<Target, ExtType>) => ExtType,
    map = new WeakMap<Target, ExtType>()
): (tgt: Target) => ExtType {
    return (tgt: Target) =>  map.has(tgt) ? map.get(tgt)! : setMap(map, tgt, factory(tgt, map))
}

/**
 * Create an extension *method*: a function that invokes a memoized closure for
 * a given target object or function.
 *
 * This function is almost identical to {@link ext}(), except that instead of an
 * accessor function, this returns a function that will *call* the extension
 * (method closure) corresponding to the target, passing along any extra
 * arguments.
 *
 * This is useful when you want to create an extension type that only has one
 * public method, and you'd rather not create a whole class for it: just set up
 * its state as variables in your factory function and return a closure. Then,
 * you can simply call `myMethod(target, ...args)`, which will look up the
 * (possibly cached) closure for `target` and call it with `(...args)`.  (You
 * could do the same thing with an {@link ext}() accessor, but then the API
 * would be `myMethod(target)(...args)`.)
 *
 * @template Target The type of target object that will be extended.  Both the
 * passed-in factory function and the returned accessor function will take a
 * parameter of this type, which must be an object or function type.  (So it's
 * suitable for weak referencing.)
 *
 * @template Method The type of the closure that will be cached.  The passed-in
 * factory function must return a value of this type, and the resulting wrapper
 * function will be of the same type but with an added initial `target`
 * parameter.  (Note: if this type has more than one call signature, only the
 * *last* overload will be used in the resulting method signature, due to
 * TypeScript compiler limitations.)
 *
 * @param factory Function called with a target object or function and a weakmap
 * to create a method closure for that target.  The result is cached in the
 * weakmap so the factory is called at most once per target (unless you alter
 * the weakmap contents directly).
 *
 * @param map Optional: the weakmap to use to store the method closures.  This
 * allows you to manipulate the map contents (e.g. remove items or clear it)
 * from outside the factory function.  If no map is provided, one is created
 * automatically, but then it's only accessible via the factory function's
 * second parameter.
 *
 * @returns A wrapper function that always invokes the same closure for a given
 * target (assuming you don't alter the WeakMap), calling the factory function
 * if a method closure doesn't exist yet for that target.  When called, the
 * wrapper function returns the result of calling the closure with the same
 * arguments (minus an initial `target` argument).
 */
export function method<Target extends object, Method extends PlainFunction>(
    factory: (tgt: Target, map: WeakMap<Target, Method>) => Method,
    map = new WeakMap<Target, Method>()
): (tgt: Target, ...args: Parameters<Method>) => ReturnType<Method> {
    return (tgt: Target, ...args) => (map.get(tgt) ?? setMap(map, tgt, factory(tgt, map)))(...args)
}

const classMap = /* @__PURE__ */ ext(<C extends Ext.Class>(cls: C) => new WeakMap<Ext.Target<C>, Ext.Type<C>>());


/** Helper types for working with {@link Ext} Subclasses @experimental */
export namespace Ext {
    /** Get the target type of an {@link Ext} subclass constructor */
    export type Target<T extends Ext.Class> = InstanceType<T>["of"]

    /**
     * Get the type of extension that will be returned by the static API.
     *
     * Defaults to the subclass instance type, but can be changed by overriding
     * {@link Ext.__new__ `__new__()`} to return a different type.
     */
    export type Type<T extends Ext.Class> = InstanceType<T> extends {__new__(ob: any): infer R}
        ? (unknown extends R ? InstanceType<T> : R)  // default to InstanceType if unknown
        : InstanceType<T>

    /**
     * The type constraint for static generics in the API; you probably won't use this directly.
     */
    export type Class = typeof Ext<WeakKey>
}


/**
 * A base class for more complex extension types, providing static accessor and
 * management APIs.  (e.g. `MyExt.for(aTarget)`, `MyExt.delete(aTarget)`, etc.)
 *
 * To create an extension class, just subclass Ext with an appropriate target
 * type, e.g.:
 *
 * ```ts
 * class MyExt extends Ext<MyTargetType> {
 *     // ...
 * }
 * ```
 * You can then use `MyExt.for()`, `.delete()`, `.has()`, etc. on instances of
 * `MyTargetType`, to manage the `MyExt` instances attached to them.
 *
 * @template Target The type of target this extension will extend.
 *
 * @categoryDescription Extension Management
 *
 * Static methods for working with extensions of the subclass type, e.g.
 * `MyExt.for(someTarget)`.
 *
 * @categoryDescription Lifecycle Hooks
 *
 * Instance and static members you can override to customize extension creation,
 * deletion, target and return types.
 *
 * @experimental
 */
export abstract class Ext<Target extends WeakKey=WeakKey> {
    /**
     * The target the extension was created for (set automatically by the base
     * class constructor).  You can narrow the target type either by extending
     * `Ext<SomeType>` directly, or by using `declare readonly of: SomeType` in
     * your subclass.
     *
     * @category Lifecycle Hooks
     */
    readonly of: Target

    /**
     * @deprecated Use `.for()` or `prototype.__inst__()` instead!
     *
     * Never directly call the constructor of an Ext subclass.  If you're
     * creating an instance in {@link __new__ `__new__()`}, use the
     * {@link __inst__ `__inst__()`} method instead.  Otherwise,
     * you should use the .for or .get methods, as they are properly typed
     * and won't create multiple instances for the same target.
     */
    constructor(of: Target) {
        this.of = of;
    }

    /**
     * Get or create an extension instance for the given target.
     * @category Extension Management
     */
    static for<Class extends Ext.Class>(this: Class, tgt: Ext.Target<Class>): Ext.Type<Class> {
        const map = classMap(this)
        return map.get(tgt) ?? setMap(map, tgt, this.prototype.__new__(tgt) as Ext.Type<Class>);
    }

    /**
     * Get the current extension instance for the given target, or `undefined`
     * if there isn't one.
     *
     * @category Extension Management
     */
    static get<Class extends Ext.Class>(this: Class, tgt: Ext.Target<Class>): Ext.Type<Class>|undefined {
        return classMap(this).get(tgt);
    }

    /**
     * Does an extension currently exist for the given target?
     *
     * @category Extension Management
     */
    static has<Class extends Ext.Class>(this: Class, tgt: Ext.Target<Class>): boolean {
        return classMap(this).has(tgt);
    }

    /**
     * Delete the current extension for the given target (if one exists), after calling the
     * {@link __del__ `__del__()`} method on it.
     *
     * @category Extension Management
     */
    static delete<Class extends Ext.Class>(this: Class, tgt: Ext.Target<Class>): void {
        const map = classMap(this)
        if (map.has(tgt)) {
            this.__del__(tgt)
            map.delete(tgt)
        }
    }

    /**
     * This method is called by {@link for}() to create the extension instance
     * for a target. You can override this method to customize instance creation
     * behavior, e.g. to execute the constructor within a job, or create a
     * promise for an extension instance to be asynchronously initiaized, etc.
     *
     * For example:
     *
     * ```ts
     * class AsyncExt extends Ext<SomeType> {
     *     // simulate slow initialization
     *     *setup() { yield *sleep(100); return this; }
     *
     *     __new__(tgt: SomeType): Job<this> {
     *         const ext = this.__inst__(tgt);
     *         return start(this.__inst__(tgt).setup())
     *     }
     * }
     * ```
     *
     * Now, `AsyncExt.for(someTarget)` will create and cache  a Job yielding an
     * extension whose `setup()` has finished. (And subclasses of `AsyncExt`
     * will share the same behavior, while being subtyped appropriately.)
     *
     * @remarks Note that while this is technically an instance method, it's
     * actually called with the class *prototype*, so you should not use any
     * properties or methods of `this` other than `__inst__`.  Think of it
     * as a function that's just on the class as a convenient way of configuring
     * it.
     *
     * @category Lifecycle Hooks
     */
    __new__<C extends Ext>(this: C, tgt: C["of"]): unknown {
        return this.__inst__(tgt)
    }

    /**
     * Given a target, create an extension instance.
     *
     * You do not need to override this, nor should you: it's just a type-safe
     * way to construct an extension instance, since an Ext subclass's
     * constructor may accept a wider type than the class actually requires.
     *
     * @category Lifecycle Hooks
     */
    __inst__<T extends Ext>(this: T, tgt: T["of"]): T {
        return new(this.constructor as new(of: T["of"]) => T)(tgt)
    }

    /**
     * This method is called by {@link delete}() if it finds an existing
     * extension for the target. You can override it in a subclass to do any
     * necessary cleanup on the extension.  (If you need to retrieve the
     * extension, you can call .get() on the target.)
     *
     * @category Lifecycle Hooks
     */
    static __del__<Class extends Ext.Class>(this: Class, _target: Ext.Target<Class>) {}
}
