export function setMap<K, V>(map: { set(key: K, val: V): void; }, key: K, val: V) {
    map.set(key, val);
    return val;
}
