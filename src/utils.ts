/**
 * Return the given value if it is an `Error`, otherwise return `undefined`.
 * @param e the value to check
 */
export function errorOrUndefined(e: unknown): Error | undefined {
    if (e instanceof Error) {
        return e;
    }
    return undefined;
}
