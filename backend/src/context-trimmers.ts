import { ChatCompletionMessageParam } from "openai/src/resources/chat/completions/completions";
import assert from "node:assert";
import { log } from "./logging";

export interface ContextTrimmer {
    /**
     * Trim a list of messages to fit certain constraints.
     *
     * If there is a system message, it will be preserved, even if it means violating the constraints.
     *
     * It is assumed that the system message (if any) is the first message in the list.
     * If there is a system message in any other position, or if there are multiple system messages,
     * the behavior of this function is undefined.
     *
     * The returned list of messages will never start with a tool message.
     * If trimming would result in a leading tool message, it will be removed.
     *
     * @param messages the list of messages to trim (won't be modified)
     * @return a new list of messages that fits the constraints
     */
    trimContext(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[];
}

export class MessageCountContextTrimmer implements ContextTrimmer {
    private readonly maxMessageCount: number;

    constructor(maxMessageCount: number = 10) {
        assert(maxMessageCount > 0, "maxMessageCount must be greater than 0");
        this.maxMessageCount = maxMessageCount;
    }

    trimContext(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
        if (messages.length <= this.maxMessageCount) {
            return Array.from(messages);
        }
        const trimmedMessages = trimContextBasedOnWeightFunction(
            messages,
            () => 1,
            this.maxMessageCount
        );
        removeOrphanedToolMessage(trimmedMessages);
        log.debug(
            `Trimmed context from ${messages.length} messages to ${trimmedMessages.length} messages`
        );
        return trimmedMessages;
    }
}

/**
 * A context trimmer that estimates the token count of messages and trims them to fit within a maximum token limit.
 * The estimation is based on a simple heuristic: 1 token per 4 characters in the message content, plus 1 token for the role.
 *
 * Note the following edge cases:
 * - It is possible that for the returned message list to be shorter than `minMessagesToKeep`
 *   if the earliest message in the trimmed list is a tool message.
 * - If `minMessagesToKeep` is 0, the returned message list may be empty.
 *   This can happen if the most recent message is very long.
 * - If `minMessagesToKeep` is non-0 the returned message list may have more than `maxTokens` tokens.
 */
export class EstimatedTokenCountContextTrimmer implements ContextTrimmer {
    private readonly maxTokens: number;
    private readonly minMessagesToKeep: number;

    constructor(maxTokens: number = 2000, minMessagesToKeep: number = 1) {
        assert(maxTokens > 0, "maxTokens must be greater than 0");
        assert(minMessagesToKeep >= 0, "minMessagesToKeep must be non-negative");
        this.maxTokens = maxTokens;
        this.minMessagesToKeep = minMessagesToKeep;
    }

    trimContext(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
        const weightFunction = (msg: ChatCompletionMessageParam): number => {
            // Rough estimate: 1 token per 4 characters + 1 token for role
            return Math.ceil((msg.content?.length ?? 0) / 4) + 1;
        };
        const trimmedMessages = trimContextBasedOnWeightFunction(
            messages,
            weightFunction,
            this.maxTokens,
            this.minMessagesToKeep
        );
        removeOrphanedToolMessage(trimmedMessages);
        if (trimmedMessages.length < messages.length) {
            log.debug(
                `Trimmed context from ${messages.length} messages to ${trimmedMessages.length} messages based on estimated token count`
            );
        }
        return trimmedMessages;
    }
}

/**
 * A context trimmer that simply returns a shallow copy of the input messages.
 * Your software can't be considered enterprise-grade until it has a no-op implementation of every interface.
 */
export class NoOpContextTrimmer implements ContextTrimmer {
    trimContext(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
        return Array.from(messages);
    }
}

/**
 * Modify a list of messages in place by removing a leading tool message if it exists.
 * @param messages the list of messages to modify
 */
function removeOrphanedToolMessage(messages: ChatCompletionMessageParam[]): void {
    if (messages.length === 0) {
        return;
    }
    if (messages[0].role === "tool") {
        messages.shift();
    }
}

function trimContextBasedOnWeightFunction(
    messages: ChatCompletionMessageParam[],
    weightFunction: (msg: ChatCompletionMessageParam) => number,
    maxWeight: number,
    minMessagesToKeep: number = 0
): ChatCompletionMessageParam[] {
    let totalWeight = 0;
    const trimmedMessages: ChatCompletionMessageParam[] = [];

    // Preserve the system message if it exists
    let systemMessage: ChatCompletionMessageParam | null = null;
    if (messages.length > 0 && messages[0].role === "system") {
        systemMessage = messages[0];
        totalWeight += weightFunction(systemMessage);
    }
    messages = messages.slice(1);

    // Iterate from the end to the beginning to keep the most recent messages
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const messageWeight = weightFunction(message);

        if (
            totalWeight + messageWeight <= maxWeight ||
            trimmedMessages.length < minMessagesToKeep
        ) {
            // If adding this message doesn't exceed the max weight, include it
            trimmedMessages.push(message);
            totalWeight += messageWeight;
        } else {
            // If it exceeds, stop adding more messages
            break;
        }
    }

    // Add the system message back if there was one
    if (systemMessage) {
        trimmedMessages.push(systemMessage);
    }

    // Since we iterated backwards, we need to reverse the result to maintain original order
    trimmedMessages.reverse();

    // Remove leading tool message if it exists
    removeOrphanedToolMessage(trimmedMessages);

    return trimmedMessages;
}
