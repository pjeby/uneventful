export const EXT_ATTR = "uneventful/ext" as const;

export type ExtKey = symbol | string;
export type ExtType<K extends ExtKey,V> = {key: K, val: V};
export type MaybeHas<T extends AnyExt> = {["uneventful/ext"]?: {[key in T["key"]]?: T["val"]}};

type AnyExt = ExtType<ExtKey, any>;

type GetSet<X extends AnyExt> = {
    get(ob: MaybeHas<X>): X["val"];
    set(ob: MaybeHas<X>, v: X["val"]): X["val"];
}

export function extension<X extends AnyExt>(k: X["key"]): GetSet<X> {
    return {
        set(ob, v) { return (ob[EXT_ATTR] ||= {[k]: v} as any)[k] = v; },
        get(ob)    { return ob?.[EXT_ATTR]?.[k]; },
    }
}

