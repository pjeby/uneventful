export type SetOrSingle<T> = T | Set<T> | undefined;

export function sosSize<T>(set: SetOrSingle<T>): number {
    return set ? (set instanceof Set ? set.size : 1) : 0;
}
export function sosAdd<T>(set: SetOrSingle<T>, item: T): SetOrSingle<T> {
    return set ? (set instanceof Set ? (set.add(item), set) : new Set([set, item])) : item;
}
export function sosDel<T>(set: SetOrSingle<T>, item: T): SetOrSingle<T> {
    if (set !== item) return set instanceof Set ? (set.delete(item), set) : set;
    return undefined
}
export function sosHas<T>(set: SetOrSingle<T>, item: T): boolean {
    return set === item || (set instanceof Set && set.has(item));
}
