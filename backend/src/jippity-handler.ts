import {
    Action,
    ActionMessage,
    ActionResultMessage,
    deserializeMessage,
    ForceActionMessage,
    Message,
    validateActionSchema
} from "./api-types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { openai, openaiModel, send, SYSTEM_MESSAGE } from "./index";
import { log } from "./logging";
import assert from "node:assert";

import { convertActionToTool, convertForcedActionMessageToOpenAIMessage } from "./utils";
import { Queue } from "./queue";
import { State } from "./jippity-types";

// ******************************
// * AI and Game State Tracking *
// ******************************

// Stores the state of the game and the AI
export class JippityHandler {
    // isStarted: boolean = false;
    game: string | undefined = undefined;
    actions: Action[] = [];
    openaiMessages: ChatCompletionMessageParam[] = [SYSTEM_MESSAGE];
    pendingActionId: string | null = null;
    // If true, then no other requests to OpenAI will be made
    // This is the closest thing I could find to a mutex lock
    // Who knew JavaScript was single-threaded? Not me.
    // openaiRequestInProgress = false;

    state: State = { id: "state/waiting-for-game-startup" };

    /** Messages received while an OpenAI API request is pending will be added here */
    messageQueue = new Queue<Message>();

    // **************************
    // * Calling the OpenAI API *
    // **************************

    public async callOpenAI(forceActionMessage?: ForceActionMessage): Promise<void> {
        assert(
            this.state.id !== "state/waiting-for-game-startup",
            "This method should not be called before the game has started"
        );
        // assert(
        //     !this.openaiRequestInProgress,
        //     "This method should not be called while a request to the OpenAI API is in progress"
        // );

        const oldState = this.state;
        this.state = { id: "state/thinking" };
        log.debug(
            `callOpenAI() >> oldState: ${JSON.stringify(oldState)}, newState: ${JSON.stringify(this.state)}`
        );
        const body: ChatCompletionCreateParamsNonStreaming = {
            model: openaiModel,
            messages: [...this.openaiMessages],
            response_format: {
                type: "text"
            },
            temperature: 1,
            max_completion_tokens: 2048,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        }
        return openai.chat.completions
            .create({
                model: openaiModel,
                messages: [...this.openaiMessages],
                response_format: {
                    type: "text"
                },
                tools: tools,
                temperature: 1,
                max_completion_tokens: 2048,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0
            })
            .then((response) => {
                assert(response.choices.length == 1);
                const choice = response.choices[0];
                if (choice.finish_reason === "stop") {
                    const content = choice.message.content;
                    assert(
                        content,
                        "Surely there would be content if the model stopped on its own"
                    );
                    log.info(`Jippity says: ${content}`);
                    // this.openaiRequestInProgress = false;
                    this.state = { id: "state/idle" };
                    return;
                } else if (choice.finish_reason === "tool_calls") {
                    let toolCalls = choice.message.tool_calls;
                    assert(
                        toolCalls && toolCalls.length >= 1,
                        "Why would the stop reason be tool_calls if there were no tool calls?"
                    );
                    if (toolCalls.length > 1) {
                        log.warn(
                            `OpenAI response finished with multiple tool calls. Only the first will be considered.`
                        );
                        toolCalls = [toolCalls[0]];
                        choice.message.tool_calls = [toolCalls[0]];
                    }
                    const toolCall = toolCalls[0];
                    assert(toolCall.type === "function");
                    const action: ActionMessage = {
                        command: "action",
                        data: {
                            id: toolCall.id,
                            name: toolCall.function?.name,
                            data: toolCall.function?.arguments
                        }
                    };
                    this.pendingActionId = toolCall.id;
                    if (forceActionMessage) {
                        this.state = {
                            id: "state/pending-forced-action",
                            action: action,
                            forcedAction: forceActionMessage
                        };
                    } else {
                        this.state = { id: "state/pending-action", action: action };
                    }
                    log.info(`Jippity wants to do the following action: ${JSON.stringify(action)}`);
                    this.openaiMessages.push(choice.message);
                    send(action);
                    return;
                } else {
                    log.error(
                        `OpenAI response finished with the following reason: ${choice.finish_reason}`
                    );
                    this.state = { id: "state/exiting", reason: "Error calling OpenAI API" };
                    // this.openaiRequestInProgress = false;
                    throw new Error("I should be handling this case but I'm not"); // TODO: Handle this case
                }
            })
            .catch((error) => {
                log.error("Error calling OpenAI API", error);
                this.state = { id: "state/exiting", reason: "Error calling OpenAI API" };
                // this.openaiRequestInProgress = false;
            });
    }

    // public enqueueMessage(dataStr: string) {
    //     const messageResult = deserializeMessage(dataStr);
    //     if (messageResult.isErr()) {
    //         log.error(`Failed to deserialize message: ${messageResult.error}`);
    //         return false;
    //     }
    //     const message = messageResult.value;
    //
    //     this.messageQueue.offer(message);
    // }

    public receiveMessage(dataStr: string): void {
        const messageResult = deserializeMessage(dataStr);
        if (messageResult.isErr()) {
            log.error(`Failed to deserialize message: ${messageResult.error}`);
            return;
        }
        const message = messageResult.value;

        switch (this.state.id) {
            case "state/waiting-for-game-startup":
            case "state/idle":
            case "state/pending-action":
            case "state/pending-forced-action":
                this.handleMessage(message);
                break;
            default:
                log.debug(
                    `Added message with "${message.command}" command to message queue (current state is ${this.state.id})`
                );
                this.messageQueue.offer(message);
                break;
        }
    }

    public handleMessage(message: Message): boolean {
        if (this.state.id === "state/waiting-for-game-startup" && message.command !== "startup") {
            log.error(`Received "${message.command}" command before receiving a "startup" command`);
            return false;
        }

        // If an action is pending, disallow all commands apart from action/result, actions/register, and actions/unregister
        if (
            (this.state.id === "state/pending-action" ||
                this.state.id === "state/pending-forced-action") &&
            message.command !== "action/result" &&
            message.command !== "actions/register" &&
            message.command !== "actions/unregister"
        ) {
            log.error(`Received "${message.command}" command while waiting for an action result`);
            return false;
        }

        switch (message.command) {
            case "startup":
                this.state = { id: "state/idle" };
                this.game = message.game;
                this.actions = [];
                log.info(`Set game to "${message.game}" and cleared all registered actions`);
                this.openaiMessages.push({
                    role: "user",
                    content: `You are now playing ${message.game}`
                } as ChatCompletionMessageParam);
                this.callOpenAI();
                return true;
            case "actions/register":
                this.registerActions(message.data.actions);
                return true;
            case "actions/unregister":
                this.unregisterActions(message.data.action_names);
                return true;
            case "context":
                this.addContext(message.data.message, message.data.silent);
                return true;
            case "actions/force":
                this.handleForcedAction(message);
                return false;
            case "action/result":
                this.addActionResult(message);
                return true;
            case "action":
                log.error(
                    'The "action" command should be sent from the server (Neuro) to the client (the game), not the other way around.'
                );
                return false;
        }
    }

    public processMessageQueue() {
        while (this.messageQueue.isNotEmpty()) {
            const message = this.messageQueue.poll();
            assert(
                message,
                "The message queue is not empty, but the poll operation returned undefined"
            );
            this.handleMessage(message);
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
            const actionSchemaValidationResult = validateActionSchema(action);
            if (actionSchemaValidationResult.isErr()) {
                log.error(
                    `Attempted to register action "${action.name}" with an invalid schema: ${actionSchemaValidationResult.error}`
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

    private handleForcedAction(message: ForceActionMessage) {
        const openAIMessage = convertForcedActionMessageToOpenAIMessage(message, "before-result");
        this.openaiMessages.push(openAIMessage);
        this.callOpenAI();
    }

    private addContext(message: string, silent: boolean) {
        assert(
            !this.pendingActionId,
            "Received a context message while waiting for an action result"
        );
        const context: ChatCompletionMessageParam = {
            role: "user",
            content: message
        };
        this.openaiMessages.push(context);
        if (!silent) {
            this.callOpenAI();
        }
    }

    private addActionResult(message: ActionResultMessage) {
        assert(
            this.state.id === "state/pending-action" ||
                this.state.id === "state/pending-forced-action",
            `addActionResult() should not be called in the current state: ${this.state.id}`
        );
        const pendingAction = this.state.action;
        if (pendingAction.data.id !== message.data.id) {
            log.error("Received an action result with an ID that doesn't match the pending action");
            return;
        }
        const content = {
            success: message.data.success,
            message: undefined as string | undefined
        };
        if (message.data.message) {
            content.message = message.data.message;
        }
        const actionResult: ChatCompletionMessageParam = {
            role: "tool",
            tool_call_id: message.data.id,
            content: JSON.stringify(content)
        };
        this.openaiMessages.push(actionResult);
        this.pendingActionId = null;
        this.callOpenAI();
    }
}
