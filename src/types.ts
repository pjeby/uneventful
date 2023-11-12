export interface Activity<T> extends Promise<T> {

    /** Terminate the activity with a given result */
    return(val?: T): void;

    /** Terminate the activity with an error */
    throw(error: any): void;

    /** Register a callback to run when the activity ends */
    onEnd(cb: () => void): void;
}

export interface Job<T> extends Activity<T> {}

export type Nothing = undefined | null | void;
export type PlainFunction = (this: void, ...args: any[]) => any;
