import { isIdleTimerStimulus, isMessageStimulus, ReactionMessage, Stimulus } from "./jippity-types";
import {
    Action,
    ActionMessage,
    ContextMessage,
    ForceActionMessage,
    isContextMessage,
    isForceActionMessage,
    isNonSilentContextMessage,
    isSilentContextMessage,
    Message,
    StartupMessage
} from "./api-types";
import { log } from "./logging";
import assert from "node:assert";
import { ChatCompletionCreateParamsNonStreaming } from "openai/src/resources/chat/completions";
import { chatCompletionWithLogging, convertActionToTool, extractRequestIdFromError } from "./utils";
import { openai, openaiModel, send, SYSTEM_MESSAGE } from "./index";
import {
    ChatCompletionMessage,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam
} from "openai/resources/chat/completions";
import util from "util";
import { ActionResultManager } from "./action-result-manager";
import { ContextTrimmer, EstimatedTokenCountContextTrimmer } from "./context-trimmers";
import { ReasoningEffort } from "openai/src/resources/shared";

export class Jippity {
    // Things that should be configurable
    // ----------------------------------
    // Max tokens to generate in a single response
    // If the model tries to generate more than this, the program will just crash.
    // Let me know if you have an idea for a more graceful way to handle this.
    private readonly MAX_COMPLETION_TOKENS = 4096;
    // Adjust this to control how much effort the model puts into reasoning about its actions
    // Set it to null to use the model's default, or if the model doesn't support this parameter
    private readonly REASONING_EFFORT: ReasoningEffort = "low";
    // Context window management parameters
    // See EstimatedTokenCountContextTrimmer for details
    private readonly CONTEXT_MAX_TOKENS = 4096;
    private readonly CONTEXT_MIN_MESSAGES_TO_KEEP = 2; //
    // ----------------------------------

    // Whether the main loop is running
    private isMainLoopRunning = false;

    // state: State = toWaitingForGameState();
    state: { id: string } = { id: "state/waiting-for-game-startup" };

    game: string | null = null;

    // Registered actions
    actions: Action[] = [];

    // --- Message Queues ---
    private contextBuffer: ContextMessage[] = [];
    private reactionQueue: ReactionMessage[] = [];
    // private reactionResolver: ((msg: Message) => void) | null = null;

    private stimulusResolver: PromiseWithResolvers<Stimulus> | null = null;

    private startUpMessageResolver: PromiseWithResolvers<StartupMessage> | null = null;

    private actionResultManager = new ActionResultManager();

    // The initial system message seen by the LLM

    private systemMessage = SYSTEM_MESSAGE;
    // The messages sent to the LLM, excluding the system prompt and the pending tool call, if any
    private llmMessages: ChatCompletionMessageParam[] = [];

    // TODO: Make this customizable
    private contextTrimmer: ContextTrimmer = new EstimatedTokenCountContextTrimmer(
        this.CONTEXT_MAX_TOKENS,
        this.CONTEXT_MIN_MESSAGES_TO_KEEP
    );

    constructor() {}

    async startMainLoop() {
        assert(
            this.state.id === "state/waiting-for-game-startup",
            "startMainLoop() should only be called when Jippity is first created"
        );
        assert(!this.isMainLoopRunning, "startMainLoop() should only be called once");
        this.isMainLoopRunning = true;

        const startUpMessage = await this.waitForStartupMessage();
        assert(startUpMessage.command === "startup", "Expected startup message");
        this.state = { id: "state/idle" };
        this.game = startUpMessage.game;
        log.info(`Game started: ${this.game}`);

        // Main loop
        log.debug("Jippity main loop starting...");
        while (true) {
            assert(
                this.state.id !== "state/waiting-for-game-startup",
                "Should not be in waiting-for-game-startup state in main loop"
            );

            const stimulus = await this.waitForStimulus();
            log.debug(`Received stimulus: ${util.inspect(stimulus, { breakLength: Infinity })}`);

            // Update the context window before thinking or acting
            this.processContextBuffer();
            this.trimLlmMessages();

            if (isIdleTimerStimulus(stimulus)) {
                await this.thinkAndMaybeAct();
            } else if (isMessageStimulus(stimulus)) {
                const message = stimulus.message;
                if (isContextMessage(message)) {
                    assert(
                        !message.data.silent,
                        "Silent context messages should not count as stimuli"
                    );
                    await this.thinkAndMaybeAct(message);
                } else if (isForceActionMessage(message)) {
                    await this.handleForceActionMessage(message);
                } else {
                    throw new Error(`Unexpected message stimulus type: ${message}`);
                }
            } else {
                throw new Error(`Unexpected stimulus type: ${stimulus}`);
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
            assert(this.state.id === "state/waiting-for-game-startup");
            if (!this.startUpMessageResolver) {
                this.startUpMessageResolver = Promise.withResolvers<StartupMessage>();
            }
            this.startUpMessageResolver.resolve(message);
            return;
        }

        // Handle action result messages immediately.
        if (message.command === "action/result") {
            log.info(
                `Received action result from game: ${util.inspect(message.data, { breakLength: Infinity })}`
            );
            try {
                this.actionResultManager.resolvePendingAction(message);
                log.debug(`Resolved pending action for id ${message.data.id}`);
            } catch (e) {
                log.error(
                    "Error resolving pending action. " +
                        "This means there's either a bug in Jippity or in the game. " +
                        "Check to see if multiple action/result messages were sent for one action. " +
                        "Cause:",
                    e
                );
            }
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

        if (isSilentContextMessage(message)) {
            // Silent context messages are only buffered for context, and do not trigger reactions
            this.contextBuffer.push(message);
            return;
        }

        if (isNonSilentContextMessage(message)) {
            // If a ForceActionMessage is present in the reactionQueue, buffer this context message instead of queueing for reaction
            const hasForceAction = this.reactionQueue.some(isForceActionMessage);
            if (hasForceAction) {
                this.contextBuffer.push(message);
                return;
            }

            // If there is a pending stimulusResolver, resolve with this context message it immediately
            if (this.reactionQueue.length === 0 && this.stimulusResolver) {
                log.debug(`Resolving stimulusResolver with context message`);
                const resolver = this.stimulusResolver;
                this.stimulusResolver = null;
                resolver.resolve({ type: "Message", message });
                return;
            }

            // Otherwise, add to reactionQueue
            this.reactionQueue.push(message);

            while (this.reactionQueue.length > 1) {
                const dropped = this.reactionQueue.shift();
                assert(dropped, "unreachable");
                // We checked before that there are no ForceActionMessages in the queue, so this must be a ContextMessage
                assert(
                    dropped?.command === "context",
                    "Only context messages should be dropped from reactionQueue"
                );
                this.contextBuffer.push(dropped);
                log.warn(
                    `Moved a ${dropped.command} message from reactionQueue to contextBuffer to reduce reactionQueue size.`
                );
            }

            return;
        }

        if (isForceActionMessage(message)) {
            // If there is a pending stimulusResolver, resolve it with this ForceActionMessage immediately
            if (this.reactionQueue.length === 0 && this.stimulusResolver) {
                log.debug(`Resolving stimulusResolver with force action message`);
                const resolver = this.stimulusResolver;
                this.stimulusResolver = null;
                resolver.resolve({ type: "Message", message });
                return;
            }

            // Remove all ContextMessages from reactionQueue and put them in contextBuffer
            const remaining: ForceActionMessage[] = [];
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
            return;
        }
    }

    private async waitForStimulus(): Promise<Stimulus> {
        // Implementation that waits for either an idle timer or a message
        if (this.reactionQueue.length > 0) {
            log.debug(
                `waitForStimulus: there are already ${this.reactionQueue.length} messages in reactionQueue`
            );
            const message = this.reactionQueue.shift()!;
            log.debug(
                `waitForStimulus: returning message stimulus from reactionQueue: ${message.command}`
            );
            return { type: "Message", message };
        }
        if (this.stimulusResolver) {
            log.error(
                "waitForStimulus: stimulusResolver already exists; please tell the maintainer about this"
            );
            throw new Error("stimulusResolver already exists");
        }
        this.stimulusResolver = Promise.withResolvers<Stimulus>();

        let resolved = false;
        const originalResolve = this.stimulusResolver.resolve;
        const originalReject = this.stimulusResolver.reject;

        // Wrap resolve/reject to ensure only one call
        this.stimulusResolver.resolve = (value) => {
            if (!resolved) {
                resolved = true;
                this.stimulusResolver = null;
                originalResolve(value);
            }
        };
        this.stimulusResolver.reject = (reason) => {
            if (!resolved) {
                resolved = true;
                this.stimulusResolver = null;
                originalReject(reason);
            }
        };

        setTimeout(() => {
            if (!resolved && this.stimulusResolver) {
                log.debug("waitForStimulus: timeout reached, resolving with IdleTimer");
                this.stimulusResolver.resolve({ type: "IdleTimer" });
            }
        }, 1000);

        return this.stimulusResolver.promise;
    }

    private async thinkAndMaybeAct(message?: ContextMessage) {
        const messages: ChatCompletionMessageParam[] = [];
        if (message) {
            messages.push({
                role: "user",
                content: `Context from ${message.game}:\n${message.data.message}`
            });
        }

        let result: {
            chatCompletionMessage: ChatCompletionMessage;
            actionMessage?: ActionMessage;
        };
        try {
            result = await this.maybeGenerateAction(messages);
        } catch (e) {
            const requestId = extractRequestIdFromError(e);
            if (requestId) {
                log.error(
                    `handleForceActionMessage: An error occurred when trying to generate a tool call (OpenAI request ID: ${requestId}):`,
                    e
                );
            } else {
                log.error(
                    "handleForceActionMessage: An error occurred when trying to generate a tool call",
                    e
                );
            }
            throw e; // TODO: Think of a more elegant way to handle this
        }

        const { chatCompletionMessage, actionMessage } = result;

        if (chatCompletionMessage.content && chatCompletionMessage.content.trim().length > 0) {
            this.speak(chatCompletionMessage.content.trim());
        }

        if (actionMessage) {
            // Send the action to the game
            log.info(
                `Sending action to game: ${util.inspect(actionMessage.data, {
                    breakLength: Infinity
                })}`
            );
            send(actionMessage);

            const actionResult = await this.actionResultManager.getActionResult(
                actionMessage.data.id
            );
            assert(actionResult.data.id === actionMessage.data.id, "Action result ID mismatch");

            // Add the context message that triggered this to llmMessages
            this.llmMessages.push(...messages);
            // Add the chat completion message (i.e., the tool call) to llmMessages
            this.llmMessages.push(chatCompletionMessage);
            // Add the action result to llmMessages as a tool message
            const actionResultContent = actionResult.data.message
                ? { success: actionResult.data.success, message: actionResult.data.message }
                : { success: actionResult.data.success };
            const actionResultMessage: ChatCompletionToolMessageParam = {
                role: "tool",
                tool_call_id: actionResult.data.id,
                content: JSON.stringify(actionResultContent)
            };
            this.llmMessages.push(actionResultMessage);
        } else {
            // No action was generated, just add the context message and chat completion message to llmMessages
            this.llmMessages.push(...messages);
            this.llmMessages.push(chatCompletionMessage);
        }
    }

    private async handleForceActionMessage(message: ForceActionMessage): Promise<void> {
        // Get the list of allowed actions
        const allowedActionNames = message.data.action_names;
        const allowedActions = this.actions.filter((a) => allowedActionNames.includes(a.name));
        if (allowedActions.length === 0) {
            const availableActionNamesStr = this.actions.map((a) => a.name).join(", ");
            const actionNamesStr = allowedActionNames.join(", ");
            throw new Error(
                `handleForceActionMessage: None of the specified actionNames are registered actions; specified action names: ${actionNamesStr}; registered action names: ${availableActionNamesStr}.`
            );
        }

        const queryMessage: ChatCompletionUserMessageParam = {
            role: "user",
            content: `${message.data.query}\n\nYou must use one of the following tools: ${allowedActionNames.join(", ")}`
        };

        let result: {
            chatCompletionMessage: ChatCompletionMessage;
            actionMessage: ActionMessage;
        } | null = null;
        try {
            result = await this.forceGenerateAction(allowedActions, [queryMessage]);
        } catch (e) {
            const requestId = extractRequestIdFromError(e);
            if (requestId) {
                log.error(
                    `handleForceActionMessage: An error occurred when trying to generate a tool call (OpenAI request ID: ${requestId}):`,
                    e
                );
            } else {
                log.error(
                    "handleForceActionMessage: An error occurred when trying to generate a tool call",
                    e
                );
            }
            throw e; // TODO: Think of a more elegant way to handle this
        }

        const { chatCompletionMessage, actionMessage } = result;

        // Send the action to the game
        log.info(
            `Sending action to game: ${util.inspect(actionMessage.data, {
                breakLength: Infinity
            })}`
        );
        send(actionMessage);

        const actionResult = await this.actionResultManager.getActionResult(actionMessage.data.id);
        assert(actionResult.data.id === actionMessage.data.id, "Action result ID mismatch");

        if (!actionResult.data.success) {
            // TODO: Retry failed actions for force actions
            log.warn(
                `handleForceActionMessage: Action ${actionMessage.data.id} failed according to the game. Jippity should immediately retry this action, but this is not yet implemented.`
            );
            return;
        }

        // Add the query message to llmMessages unless ephemeral_context is true
        if (!message.data.ephemeral_context) {
            this.llmMessages.push(queryMessage);
        }
        // Add the chat completion message (i.e., the tool call) to llmMessages
        this.llmMessages.push(chatCompletionMessage);
        // Add the action result to llmMessages as a tool message
        const actionResultContent = actionResult.data.message
            ? { success: actionResult.data.success, message: actionResult.data.message }
            : { success: actionResult.data.success };
        const actionResultMessage: ChatCompletionToolMessageParam = {
            role: "tool",
            tool_call_id: actionResult.data.id,
            content: JSON.stringify(actionResultContent)
        };
        this.llmMessages.push(actionResultMessage);
    }

    private async forceGenerateAction(
        allowedActions: Action[],
        additionalMessages: ChatCompletionMessageParam[] = []
    ): Promise<{ chatCompletionMessage: ChatCompletionMessage; actionMessage: ActionMessage }> {
        assert(allowedActions.length > 0, "forceGenerateAction: allowedActions must not be empty");

        // Build messages
        const messages: ChatCompletionMessageParam[] = [
            this.systemMessage,
            ...this.llmMessages,
            ...additionalMessages
        ];
        const body: ChatCompletionCreateParamsNonStreaming = {
            model: openaiModel,
            messages: messages,
            response_format: {
                type: "text"
            },
            temperature: 1,
            max_completion_tokens: this.MAX_COMPLETION_TOKENS,
            frequency_penalty: 0,
            presence_penalty: 0,
            tools: allowedActions.map(convertActionToTool),
            tool_choice: "required",
            parallel_tool_calls: false
        };
        if (this.REASONING_EFFORT) {
            body.reasoning_effort = this.REASONING_EFFORT;
        }
        log.debug(
            `forceGenerateAction: Sending request to OpenAI: ${util.inspect(body, { breakLength: Infinity })}`
        );
        const response = await chatCompletionWithLogging(() =>
            openai.chat.completions.create(body)
        );
        log.debug(
            `forceGenerateAction: Received response from OpenAI: ${util.inspect(response, { breakLength: Infinity })}`
        );

        if (response.choices.length === 0) {
            throw new Error("OpenAI response included no choices");
        } else if (response.choices.length > 1) {
            log.warn("OpenAI response included multiple choices; only the first will be used");
        }

        const choice = response.choices[0];

        // Make sure there are actually tool calls in the response
        if (choice.finish_reason !== "tool_calls") {
            throw new Error(
                `forceGenerateAction: OpenAI response does not include a tool call; finish_reason = ${choice.finish_reason}`
            );
        }
        const chatCompletionMessage = choice.message;
        const outerToolCalls = chatCompletionMessage.tool_calls;
        if (!outerToolCalls || outerToolCalls.length === 0) {
            throw new Error(
                "forceGenerateAction: OpenAI response includes no tool calls despite finish_reason being tool_calls"
            );
        } else if (outerToolCalls.length > 1) {
            log.warn(
                "forceGenerateAction: OpenAI response includes multiple tool calls; only the first will be used"
            );
            chatCompletionMessage.tool_calls = [outerToolCalls[0]];
        }
        const toolCall = outerToolCalls[0];
        if (toolCall.type !== "function") {
            throw new Error(
                `forceGenerateAction: OpenAI response includes a non-function tool call of type ${toolCall.type}; only function tool calls are supported`
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

        const allowedActionNames = allowedActions.map((a) => a.name);
        if (!(actionMessage.data.name in allowedActionNames)) {
            log.warn(
                `forceGenerateAction: OpenAI chose action "${actionMessage.data.name}" which was not in the list of allowed actions: ${allowedActionNames.join(", ")}; the game will need to handle this.`
            );
        }

        return { chatCompletionMessage, actionMessage };
    }

    private async maybeGenerateAction(
        additionalMessages: ChatCompletionMessageParam[] = []
    ): Promise<{ chatCompletionMessage: ChatCompletionMessage; actionMessage?: ActionMessage }> {
        const messages: ChatCompletionMessageParam[] = [
            this.systemMessage,
            ...this.llmMessages,
            ...additionalMessages
        ];

        const body: ChatCompletionCreateParamsNonStreaming = {
            model: openaiModel,
            messages: messages,
            response_format: {
                type: "text"
            },
            temperature: 1,
            max_completion_tokens: this.MAX_COMPLETION_TOKENS,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        if (this.REASONING_EFFORT) {
            body.reasoning_effort = this.REASONING_EFFORT;
        }

        // Convert actions to tools if there are any
        if (this.actions.length > 0) {
            body.tools = this.actions.map(convertActionToTool);
            // Prevent the usage of multiple tools
            body.parallel_tool_calls = false;
        }

        log.debug(`Sending request to OpenAI: ${util.inspect(body, { breakLength: Infinity })}}`);
        const response = await chatCompletionWithLogging(() =>
            openai.chat.completions.create(body)
        );
        log.debug(
            `Received response from OpenAI: ${util.inspect(response, { breakLength: Infinity })}`
        );

        if (response.choices.length === 0) {
            throw new Error("OpenAI returned no choices");
        }
        const choice = response.choices[0];
        log.debug(`OpenAI finish_reason: ${choice.finish_reason}`);

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            if (choice.message.tool_calls.length > 1) {
                log.error(
                    `Response from OpenAI contains ${choice.message.tool_calls.length} tool calls; only one is supported`
                );
                choice.message.tool_calls = [choice.message.tool_calls[0]];
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

    private async waitForStartupMessage(): Promise<StartupMessage> {
        assert(
            this.state.id == "state/waiting-for-game-startup",
            "waitForStartupMessage() can only be called in waiting-for-game-startup state"
        );
        if (!this.startUpMessageResolver) {
            log.debug(
                "waitForStartupMessage: waiting for startup message; creating new resolver startUpMessageResolver"
            );
            this.startUpMessageResolver = Promise.withResolvers<StartupMessage>();
        } else {
            log.debug(
                "waitForStartupMessage: waiting for startup message; startUpMessageResolver already exists"
            );
        }
        return this.startUpMessageResolver.promise;
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
        this.llmMessages = this.contextTrimmer.trimContext(this.llmMessages);
    }

    /**
     * Simulate Jippity speaking by logging the text.
     * This could be replaced with text-to-speech or other output methods if desired.
     */
    private speak(text: string): void {
        log.info(`Jippity says: ${text}`);
    }
}
