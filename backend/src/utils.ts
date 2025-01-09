import OpenAI from "openai";
import FunctionParameters = OpenAI.FunctionParameters;
import {
    ChatCompletionTool,
    ChatCompletionUserMessageParam
} from "openai/resources/chat/completions";
import { Action, ForceActionMessage } from "./api-types";

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

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert an {@link Action} (used by the Neuro Game API) into a {@link ChatCompletionTool} (used by the OpenAI API).
 *
 * @param action - An object conforming to the Action interface.
 * @returns A tool object formatted for OpenAI's API.
 */
export function convertActionToTool(action: Action): ChatCompletionTool {
    const { name, description, schema } = action;
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: (schema as FunctionParameters) || {}
        }
    };
}

/**
 * Convert a {@link ForceActionMessage} into an appropriate representation as a {@link ChatCompletionUserMessageParam}.
 *
 * @param forcedAction a forced action message
 * @param actionState whether an action result has been received; determines whether context should be included based on `ephemeral_context`
 */
export function convertForcedActionMessageToOpenAIMessage(
    forcedAction: ForceActionMessage,
    actionState: "before-result" | "after-result"
): ChatCompletionUserMessageParam {
    let content = "";
    if (forcedAction.data.ephemeral_context || actionState === "before-result") {
        content += `${forcedAction.data.query}\n\n`;
        if (forcedAction.data.state) {
            content += `Game state: ${forcedAction.data.state}\n\n`;
        }
    }
    content += `You must use one of the following tools: ${forcedAction.data.action_names.join(", ")}`;

    return {
        role: "user",
        content: content
    };
}
