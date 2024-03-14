export type ValueResult<T> = {op: "next",    val: T,         err: undefined};
export type ErrorResult    = {op: "throw",   val: undefined, err: any};
export type CancelResult   = {op: "cancel",  val: undefined, err: undefined};

export type FlowResult<T> = ValueResult<T> | ErrorResult | CancelResult ;

function mkResult<T>(op: "next", val?: T): ValueResult<T>;
function mkResult(op: "throw", val: undefined|null, err: any): ErrorResult;
function mkResult(op: "cancel"): CancelResult;
function mkResult<T>(op: string, val?: T, err?: any): FlowResult<T> {
    return {op, val, err} as FlowResult<T>
}

export const CancelResult = mkResult("cancel");

export function ValueResult<T>(val: T): ValueResult<T> {
    return mkResult("next", val);
}

export function ErrorResult(err: any): ErrorResult {
    return mkResult("throw", undefined, err);
}

export function isCancel(res: FlowResult<any>): res is CancelResult {
    return res === CancelResult;
}

export function isValue<T>(res: FlowResult<T>): res is ValueResult<T> {
    return res.op === "next";
}

export function isError(res: FlowResult<any>): res is ErrorResult {
    return res.op === "throw";
}

