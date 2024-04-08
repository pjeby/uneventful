
/**
 * A counted, double-ended queue with the ability to undo insertions (even out
 * of order).
 *
 * @category Chains
 */
export type Chain<T> = Node<T, number>;

/**
 * Create a new Chain
 *
 * @category Chains
 */
export function chain<T>(): Chain<T> { return new Node<T, number>; }


/**
 * Unshift a value onto the front of the chain
 *
 * @category Chains
 */
export function unshift<T>(c: Chain<T>, v: T)   { ++c.v; link(c.n, c, v); }

/**
 * Unshift a value onto the front of the chain, returning an undo callback.  The
 * callback can be invoked to remove the value from the chain at any time, even
 * after other values have been added or removed.  There is no effect if the
 * callback is run more than once, or if the value has already been removed.
 *
 * @category Chains
 */
export function unshiftCB<T>(c: Chain<T>, v: T) { ++c.v; return unlinker(c, link(c.n, c, v)); }

/**
 * Push a value onto the end of the chain
 *
 * @category Chains
 */
export function push<T>(c: Chain<T>, v: T) { ++c.v; link(c, c.p, v); }

/**
 * Push a value onto the end of the chain, returning an undo callback.  The
 * callback can be invoked to remove the value from the chain at any time, even
 * after other values have been added or removed.  There is no effect if the
 * callback is run more than once, or if the value has already been removed.
 *
 * @category Chains
 */
export function pushCB<T>(c: Chain<T>, v: T) { ++c.v; return unlinker(c, link(c, c.p, v)); }

/**
 * Return true if the chain is empty, or is null/undefined
 *
 * @category Chains
 */
export function isEmpty(c: Chain<any> | null | undefined) { return !c || c.v === 0; }

/**
 * Return the number of items in the chain, or 0 if it's null/undefined
 *
 * @category Chains
 */
export function qlen(c: Chain<any>  | null | undefined) { return c ? c.v : 0; }

/**
 * Remove a value from the end of the chain, returning it
 *
 * @category Chains
 */
export function pop<T>(c: Chain<T>) { if (qlen(c)) return unlink(c, c.p); }

/**
 * Remove a value from the front of the chain, returning it
 *
 * @category Chains
 */
export function shift<T>(c: Chain<T>) { if (qlen(c)) return unlink(c, c.n); }

/** A node in a chain */
class Node<T, V=T> {
    /** The next node (or the start node if this is a chain head) */
    n: Node<T> = this as Node<T, any>;
    /** The previous node (or the end node if this is a chain head) */
    p: Node<T> = this as Node<T, any>;
    /** The value held by the node (or the chain length if this is a chain head) */
    v: V = 0 as any;
    /** The most recently created undo callback for this node */
    u: () => void = undefined;
}

/** Recycling list for chain nodes, to reduce constructor/alloc overhead */
var free: Node<any>;

/** Create (or reuse) a node with a given value, inserting it between two nodes in a chain */
function link<T>(n: Node<T, any>, p: Node<T, any>, v: T): Node<T> {
    let node: Node<T> = free;
    if (node) {
        free = node.n;
        node.n = n || node;
        node.p = p || node;
    } else {
        node = new Node<T>;
        if (n) node.n = n;
        if (p) node.p = p;
    }
    node.v = v;
    node.n.p = node;
    node.p.n = node;
    return node;
}

/** Unlink a node from a chain and recycle it, returning the value it held */
function unlink<T>(c: Chain<any>, node: Node<T>) {
    --c.v;
    var v = node.v, u = node.u;
    node.n && (node.n.p = node.p);
    node.p && (node.p.n = node.n);
    node.u = node.v = node.p = undefined;
    node.n = free; free = node;
    if (u) u();  // drop refs to node+chain
    return v;
}

/**
 * Return an undo/remove callback that will run at most once and is a no-op if the
 * node was already removed.  If called more than once on the same node while
 * it's in the same chain, it returns the same callback.  ()
 */
function unlinker(chain: Chain<any>, node: Node<any>) {
    let u = (node.u ||= () => {
        if (u) {
            // If the node's undo callback is this callback, then it's safe to remove;
            // otherwise, the node has already been removed and/or recycled for use in
            // a different chain (or a different value in this one!)
            if (u === node.u) unlink(chain, node);
            u = chain = node = undefined;
        }
    })
    return u;
}
