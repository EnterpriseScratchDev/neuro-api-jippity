import {
    State,
    ThinkingState,
    toIdleState,
    toPendingActionState,
    toThinkingState,
    toWaitingForGameState
} from "./jippity-types";
import {
    Action,
    ActionMessage,
    ActionResultMessage,
    ContextMessage,
    isContextMessage,
    isForceActionMessage,
    Message
} from "./api-types";
import { log } from "./logging";
import assert from "node:assert";
import { ChatCompletionCreateParamsNonStreaming } from "openai/src/resources/chat/completions";
import { convertActionToTool } from "./utils";
import { openai, openaiModel, send, SYSTEM_MESSAGE } from "./index";
import {
    ChatCompletionMessage,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionMessageParam,
    ChatCompletionToolMessageParam
} from "openai/resources/chat/completions";
import util from "util";

export class Jippity {
    private isMainLoopRunning = false;

    state: State = toWaitingForGameState();

    // Registered actions
    actions: Action[] = [];

    // --- Message Queues ---
    private contextBuffer: ContextMessage[] = [];
    private reactionQueue: Message[] = [];
    private reactionResolver: ((msg: Message) => void) | null = null;

    private actionResultResolver: ((result: ActionResultMessage) => void) | null = null;

    // The initial system message seen by the LLM

    private systemMessage = SYSTEM_MESSAGE;
    // The messages sent to the LLM, excluding the system prompt and the pending tool call, if any
    private llmMessages: ChatCompletionMessageParam[] = [];

    constructor() {}

    async startMainLoop() {
        assert(
            this.state.id === "state/waiting-for-game-startup",
            "startMainLoop() should only be called when Jippity is first created"
        );
        assert(!this.isMainLoopRunning, "startMainLoop() should only be called once");
        this.isMainLoopRunning = true;

        // Main FSM loop
        log.debug("Jippity main loop starting...");
        while (true) {
            switch (this.state.id) {
                case "state/waiting-for-game-startup": {
                    // Wait for startup message
                    log.debug("Waiting for game startup message...");
                    const msg = await this.receiveNextReactionMessage();
                    if (msg.command === "startup") {
                        // Transition to idle state
                        this.state = toIdleState({ game: msg.game });
                        log.debug(
                            `Game startup detected, transitioning to idle state: ${JSON.stringify(this.state)}`
                        );
                    }
                    break;
                }
                case "state/idle": {
                    // Wait for a message that requires a reaction
                    const msg = await this.receiveNextReactionMessage();
                    if (isForceActionMessage(msg)) {
                        // Transition to thinking state with force action
                        this.state = toThinkingState(this.state, msg);
                        // } else if (this.isContextMessage(msg) && !msg.data.silent) {
                    } else if (isContextMessage(msg)) {
                        // Transition to thinking state with context message
                        this.state = toThinkingState(this.state, msg);
                    }
                    break;
                }
                case "state/thinking": {
                    this.processContextBuffer();

                    this.trimLlmMessages();
                    let chatCompletionMessage: ChatCompletionMessage;
                    let actionMessage: ActionMessage | undefined;
                    try {
                        const result = await this.maybeGenerateAction(this.state);
                        chatCompletionMessage = result.chatCompletionMessage;
                        actionMessage = result.actionMessage;
                    } catch (e) {
                        // Return to idle state on error
                        // TODO: make sure request_id is logged with the error
                        log.error("An error occurred when calling OpenAI", e);
                        this.state = toIdleState(this.state);
                        break;
                    }

                    const content = chatCompletionMessage.content;
                    if (content && content.trim().length > 0) {
                        this.speak(content.trim());
                    }

                    if (actionMessage) {
                        // Transition to pending-action state
                        log.info(
                            `Sending action to game: ${util.inspect(actionMessage, { breakLength: Infinity })}`
                        );
                        send(actionMessage); // TODO: handle send errors
                        this.state = toPendingActionState(
                            this.state,
                            actionMessage,
                            chatCompletionMessage,
                            this.state.forceAction
                        );
                    } else {
                        // No action generated, add the message to the context window and return to idle state
                        this.llmMessages.push(chatCompletionMessage);
                        this.state = toIdleState(this.state);
                    }

                    break;
                }
                case "state/pending-action": {
                    // Wait for action result message
                    const msg = await this.receiveActionResult();
                    assert(msg.data.id === this.state.action.data.id, "Action result ID mismatch");
                    const actionResultContent = msg.data.message
                        ? { success: msg.data.success, message: msg.data.message }
                        : { success: msg.data.success };
                    const actionResultMessage: ChatCompletionToolMessageParam = {
                        role: "tool",
                        tool_call_id: msg.data.id,
                        content: JSON.stringify(actionResultContent)
                    };
                    // Add the completion and action result to llmMessages
                    this.llmMessages.push(this.state.completion);
                    this.llmMessages.push(actionResultMessage);

                    // Transition back to thinking state
                    // If the action was forced and failed, keep the forceAction in the new state
                    const newState = toThinkingState(this.state, msg);
                    if (this.state.forceAction && !msg.data.success) {
                        newState.forceAction = this.state.forceAction;
                    }
                    this.state = newState;
                    break;
                }
                default: {
                    // Unknown state, log and exit
                    log.error(`Invalid state: ${this.state}`);
                    return;
                }
            }
        }
    }

    private registerActions(actions: Action[]) {
        let successfulRegistrations = 0;
        for (const action of actions) {
            if (this.actions.find((x) => x.name === action.name)) {
                log.warn(
                    `Attempted to register action "${action.name}" when there is already an action with that name`
                );
                continue;
            }
            this.actions.push(action);
            successfulRegistrations++;
        }
        if (successfulRegistrations > 0) {
            log.info(
                `Successfully registered ${successfulRegistrations} of ${actions.length} actions`
            );
        } else {
            log.error(`Failed to register any of the ${actions.length} actions`);
        }
    }

    private unregisterActions(action_names: string[]) {
        this.actions = this.actions.filter((action) => !action_names.includes(action.name));
        log.info(`Unregistered actions: ${action_names}`);
    }

    /**
     * Call this when a new message is received from the game or API.
     * This will buffer all messages for context, and only queue up messages that require a reaction.
     */
    onMessageReceived(message: Message) {
        // log.debug("onMessageReceived:", message);

        if (message.command === "startup") {
            // TODO: Handle game restart
            this.reactionQueue.push(message);
            this.resolveReactionQueue();
        }

        // Handle action result messages immediately.
        if (message.command === "action/result") {
            if (this.state.id !== "state/pending-action") {
                log.error(
                    `Received action/result message while current state is ${this.state.id}. Ignoring.`
                );
                return;
            }
            if (message.data.id !== this.state.action.data.id) {
                log.error(
                    `Received action/result message with id ${message.data.id} while waiting for result of action with id ${this.state.action.data.id}. Ignoring.`
                );
                return;
            }
            log.info(
                `Received action result from game: ${util.inspect(message.data, { breakLength: Infinity })}`
            );
            // Resolve the pending action result promise
            if (!this.actionResultResolver) {
                log.error(
                    "Received an unexpected action/result message. " +
                        "This means there's either a bug in Jippity or in the game. " +
                        "Check to see if multiple action/result messages were sent for one action."
                );
                return;
            }
            const resolver = this.actionResultResolver;
            this.actionResultResolver = null;
            resolver(message);
            return;
        }

        // Handle action registration and unregistration messages immediately.
        if (message.command === "actions/register") {
            this.registerActions(message.data.actions);
            return;
        } else if (message.command === "actions/unregister") {
            this.unregisterActions(message.data.action_names);
            return;
        }

        if (message.command === "context") {
            // If a ForceActionMessage is present in the reactionQueue, buffer this context message instead of queueing for reaction
            const hasForceAction = this.reactionQueue.some(isForceActionMessage);
            if (hasForceAction) {
                this.contextBuffer.push(message);
                return;
            }
            // Otherwise, add to reactionQueue
            this.reactionQueue.push(message);

            while (this.reactionQueue.length > 2) {
                const dropped = this.reactionQueue.shift();
                if (!dropped) {
                    break;
                }
                assert(
                    dropped?.command === "context",
                    "Only context messages should be dropped from reactionQueue"
                );
                this.contextBuffer.push(dropped);
                log.warn(
                    `Moved a ${dropped.command} message from reactionQueue to contextBuffer to reduce reactionQueue size.`
                );
            }

            this.resolveReactionQueue();
            return;
        }

        if (isForceActionMessage(message)) {
            // Remove all ContextMessages from reactionQueue and buffer them
            const remaining: Message[] = [];
            for (const msg of this.reactionQueue) {
                if (isContextMessage(msg)) {
                    this.contextBuffer.push(msg);
                } else {
                    remaining.push(msg);
                }
            }
            this.reactionQueue = remaining;
            // Add the new ForceActionMessage
            this.reactionQueue.push(message);
            this.resolveReactionQueue();
            return;
        }
    }

    /**
     * Returns the next message that requires a reaction.
     * If no such message is available, returns a Promise that resolves when one arrives.
     * If there are multiple messages in the queue, always process the oldest first.
     */
    async receiveNextReactionMessage(): Promise<Message> {
        if (this.reactionQueue.length > 0) {
            log.debug(
                `receiveNextReactionMessage: there are already ${this.reactionQueue.length} messages in reactionQueue`
            );
            return this.reactionQueue.shift()!;
        }
        // Wait for a new reaction-required message
        return new Promise<Message>((resolve) => {
            if (this.reactionResolver) {
                throw new Error("Multiple reactionResolvers detected!");
            }
            this.reactionResolver = resolve;
        });
    }

    async receiveActionResult(): Promise<ActionResultMessage> {
        if (this.state.id !== "state/pending-action") {
            throw new Error(
                "Can only wait for an action result when the state is state/pending-action"
            );
        }
        if (this.actionResultResolver) {
            throw new Error("receiveActionResult called with existing actionResultResolver");
        }
        // Wait for the result of the pending action
        return new Promise<ActionResultMessage>((resolve) => {
            this.actionResultResolver = resolve;
        });
    }

    /**
     * Helper to resolve any pending reaction message promise.
     */
    private resolveReactionQueue() {
        if (!this.reactionResolver) {
            log.debug("resolveReactionQueue: no pending reactionResolver to resolve");
            return;
        }
        // TODO: is this right?
        while (this.reactionResolver && this.reactionQueue.length > 0) {
            const msg = this.reactionQueue.shift()!;
            const resolve = this.reactionResolver;
            this.reactionResolver = null;
            if (resolve) {
                resolve(msg);
            } else {
                throw new Error("it shouldn't be possible for resolve to be null here");
            }
        }
    }

    private async maybeGenerateAction(
        state: ThinkingState
    ): Promise<{ chatCompletionMessage: ChatCompletionMessage; actionMessage?: ActionMessage }> {
        const messages: ChatCompletionMessageParam[] = [this.systemMessage, ...this.llmMessages];
        if (state.trigger?.command === "context") {
            messages.push({
                role: "user",
                content: `Context from ${state.trigger.game}:\n${state.trigger.data.message}`
            });
        }
        const body: ChatCompletionCreateParamsNonStreaming = {
            model: openaiModel,
            messages: messages,
            response_format: {
                type: "text"
            },
            temperature: 1,
            max_completion_tokens: 2048,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        // Convert actions to tools if there are any
        if (this.actions.length > 0) {
            body.tools = this.actions.map(convertActionToTool);
        }
        // Prevent the usage of multiple tools
        if (body.tools) {
            body.parallel_tool_calls = false;
        }
        if (state.forceAction) {
            const forcedActionNames = state.forceAction.data.action_names;
            const forcedActions = this.actions.filter((a) => forcedActionNames.includes(a.name));
            const hasValidForcedActions = forcedActions.length > 0;
            if (hasValidForcedActions) {
                log.info(
                    `Forcing action from: ${forcedActions
                        .map((a) => a.name)
                        .join(", ")} due to forceAction message`
                );
                body.tools = forcedActions.map(convertActionToTool);
                body.tool_choice = "required";
            } else {
                const forcedActionNamesStr = forcedActionNames.join(", ");
                const availableActionNamesStr = this.actions.map((a) => a.name).join(", ");
                log.warn(
                    `Received forceAction message with no valid action names: ${forcedActionNamesStr}. Currently available action names are ${availableActionNamesStr}. Jippity may or may not choose to take an action anyway.`
                );
                body.tools = this.actions.map(convertActionToTool);
                body.tool_choice = "auto";
            }
        }
        log.debug(`Sending request to OpenAI: ${util.inspect(body, { breakLength: Infinity })}}`);
        const response = await openai.chat.completions.create(body);
        log.debug(
            `Received response from OpenAI: ${util.inspect(response, { breakLength: Infinity })}`
        );
        if (response.choices.length === 0) {
            throw new Error("OpenAI returned no choices");
        }
        const choice = response.choices[0];

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            if (choice.message.tool_calls.length > 1) {
                log.error(
                    `Response from OpenAI contains ${choice.message.tool_calls.length} tool calls; only one is supported`
                );
            }
            assert(
                choice.message.tool_calls[0].type === "function",
                "Only function tool calls are supported"
            );
            const toolCall: ChatCompletionMessageFunctionToolCall = choice.message.tool_calls[0];

            // Check to see if the tool call matches a registered action
            // We won't actually do anything if it doesn't, but we want to log it
            const action = this.actions.find((a) => a.name === toolCall.function.name);
            if (!action) {
                log.warn(
                    `OpenAI chose unknown action "${toolCall.function.name}". The game will need to handle this.`
                );
            }

            const actionMessage: ActionMessage = {
                command: "action",
                data: {
                    id: toolCall.id,
                    name: toolCall.function?.name,
                    data: toolCall.function?.arguments
                }
            };

            return { chatCompletionMessage: choice.message, actionMessage };
        }
        return { chatCompletionMessage: choice.message };
    }

    /**
     * Process all messages in {@link contextBuffer} and add them to {@link llmMessages}.
     * This may make {@link llmMessages} very large, so {@link trimLlmMessages} should typically be called after this.
     */
    private processContextBuffer(): void {
        log.debug(`processContextBuffer: ${this.contextBuffer.length} message(s) to process`);
        if (this.contextBuffer.length === 0) {
            return;
        }
        for (const msg of this.contextBuffer) {
            this.llmMessages.push({
                role: "user",
                content: `Context from ${msg.game}:\n${msg.data.message}`
            });
        }
        this.contextBuffer = [];
    }

    /**
     * Trim the {@link llmMessages} array to keep it within a reasonable size.
     * This is a naive implementation that just keeps the last 10 messages if there are more than 15.
     */
    private trimLlmMessages(): void {
        // TODO: Implement better message trimming to fit within token limits
        // TODO: Make these values configurable
        if (this.llmMessages.length > 15) {
            this.llmMessages = this.llmMessages.slice(-10);

            const firstMessage = this.llmMessages[0];
            if (firstMessage.role === "tool") {
                // Remove incomplete tool call from the start of the message list
                this.llmMessages = this.llmMessages.slice(1);
            }
        }
    }

    /**
     * Simulate Jippity speaking by logging the text.
     * This could be replaced with text-to-speech or other output methods if desired.
     */
    private speak(text: string): void {
        log.info(`Jippity says: ${text}`);
    }
}
