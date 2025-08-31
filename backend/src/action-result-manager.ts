import { ActionResultMessage } from "./api-types";
import assert from "node:assert";

/**
 * Internal type representing a {@link Promise} with its resolve and reject functions exposed and an optional timeout handle.
 */
type ActionResultResolver = PromiseWithResolvers<ActionResultMessage> & {
    timeout?: NodeJS.Timeout;
};

/**
 * Manages pending actions and their results.
 *
 * This class theoretically allows multiple actions to be pending at once, but this shouldn't happen in practice.
 */
export class ActionResultManager {
    private resolvers: Map<string, ActionResultResolver>;

    constructor() {
        this.resolvers = new Map();
    }

    /**
     * Wait for an {@link ActionResultMessage} with the given action ID.
     * @param actionId the action ID to wait for
     * @param timeoutMs how long to wait before rejecting the promise (default: 5000 ms); use 0 or a negative number to disable timeout
     * @returns a promise that resolves to the action result message
     * @throws {Error} if an action with the same ID is already pending
     */
    async getActionResult(
        actionId: string,
        timeoutMs: number = 5000 // 5 seconds
    ): Promise<ActionResultMessage> {
        if (this.resolvers.has(actionId)) {
            throw new Error(`Action with ID ${actionId} is already pending`);
        }

        const resolver: ActionResultResolver = Promise.withResolvers();
        if (timeoutMs > 0) {
            resolver.timeout = setTimeout(() => {
                assert(
                    this.resolvers.has(actionId),
                    `Timeout triggered for action ID ${actionId} but no resolver found`
                );
                this.resolvers.delete(actionId);
                resolver.reject(
                    new Error(
                        `Timeout waiting for action result for action ID ${actionId} (timeout = ${timeoutMs} ms)`
                    )
                );
            }, timeoutMs);
        }
        this.resolvers.set(actionId, resolver);
        return resolver.promise;
    }

    /**
     * Resolve a pending action with the given {@link ActionResultMessage}.
     * @param result the action result message
     * @throws {Error} if no pending action is found for the given action ID
     */
    resolvePendingAction(result: ActionResultMessage) {
        const actionId = result.data.id;
        const resolver = this.resolvers.get(actionId);
        if (!resolver) {
            throw new Error(`No pending action found for action ID ${actionId}`);
        }
        if (resolver.timeout) {
            clearTimeout(resolver.timeout);
        }
        this.resolvers.delete(actionId);
        resolver.resolve(result);
    }
}
