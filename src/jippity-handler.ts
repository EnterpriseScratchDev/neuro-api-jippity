import {Action, ActionMessage, ActionResultMessage, deserializeMessage, validateActionSchema} from "./api-types";
import {ChatCompletionMessageParam, ChatCompletionTool} from "openai/resources/chat/completions";
import {openai, openaiModel, send, SYSTEM_MESSAGE} from "./index";
import {log} from "./logging";
import assert from "node:assert";

// ******************************
// * AI and Game State Tracking *
// ******************************


// Stores the state of the game and the AI
export class JippityHandler {
    isStarted: boolean = false;
    game: string | undefined = undefined;
    actions: Action[] = [];
    openaiMessages: ChatCompletionMessageParam[] = [SYSTEM_MESSAGE];
    pendingActionId: string | null = null;
    // If true, then no other requests to OpenAI will be made
    // This is the closest thing I could find to a mutex lock
    // Who knew JavaScript was single-threaded? Not me.
    openaiRequestInProgress = false;

    // **************************
    // * Calling the OpenAI API *
    // **************************

    public async callOpenAI(): Promise<void> {
        if (this.openaiRequestInProgress) {
            log.debug("There is already a request to OpenAI in progress");
            return;
        }
        this.openaiRequestInProgress = true;
        let tools: ChatCompletionTool[] | undefined = this.actions.map(this.convertActionToTool);
        if (tools.length === 0) {
            tools = undefined;
        }
        return openai.chat.completions.create({
            model: openaiModel,
            messages: [
                ...this.openaiMessages
            ],
            response_format: {
                type: "text"
            },
            tools: tools,
            temperature: 1,
            max_completion_tokens: 2048,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        }).then((response) => {
            assert(response.choices.length == 1);
            const choice = response.choices[0];
            if (choice.finish_reason === "stop") {
                const content = choice.message.content;
                assert(content, "Surely there would be content if the model stopped on its own");
                log.info(`Jippity says: ${content}`);
            } else if (choice.finish_reason === "tool_calls") {
                const toolCalls = choice.message.tool_calls;
                assert(toolCalls && toolCalls.length >= 1, "Why would the stop reason be tool_calls if there were no tool calls?");
                const toolCall = toolCalls[0];
                assert(toolCall.type === "function");
                const action: ActionMessage = {
                    command: "action",
                    data: {
                        id: toolCall.id,
                        name: toolCall.function?.name,
                        data: toolCall.function?.arguments,
                    }
                }
                send(action);
                log.info(`Jippity wants to do the following action: ${JSON.stringify(action)}`);
                this.pendingActionId = toolCall.id;
            } else {
                log.error(`OpenAI response finished with the following reason: ${choice.finish_reason}`)
                this.openaiRequestInProgress = false;
                throw new Error("I should be handling this case but I'm not"); // TODO: Handle this case
            }
            this.openaiMessages.push(choice.message);
            this.openaiRequestInProgress = false;
        });
    }

    public handleMessage(dataStr: string): boolean {
        const message = deserializeMessage(dataStr);
        if (message === null) {
            return false;
        }

        if (!this.isStarted && message.command !== "startup") {
            log.warn(`Received "${message.command}" command before receiving a \"startup\" command`);
        }

        switch (message.command) {
            case "startup":
                this.isStarted = true;
                this.game = message.game;
                this.actions = [];
                log.info(`Set game to \"${message.game}\" and cleared all registered actions`);
                const game_started: ChatCompletionMessageParam = {
                    role: "user",
                    content: `You are now playing ${message.game}`
                };
                this.openaiMessages.push(game_started);
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
                log.error("Handling of the \"actions/force\" command is not yet implemented");
                return false;
            case "action/result":
                this.addActionResult(message);
                return true;
            case "action":
                log.error("The \"action\" command should be sent from the server (Neuro) to the client (the game), not the other way around.");
                return false;
        }
    }

    private registerActions(actions: Action[]) {
        let successfulRegistrations = 0;
        for (const action of actions) {
            if (this.actions.find(x => x.name === action.name)) {
                log.warn(`Attempted to register action "${action.name}" when there is already an action with that name`);
                continue;
            }
            if (!validateActionSchema(action)) {
                log.error(`Attempted to register action "${action.name}" with an invalid schema`);
                continue;
            }
            this.actions.push(action);
            successfulRegistrations++;
        }
        log.info(`Successfully registered ${successfulRegistrations} of ${actions.length} actions`);
    }

    private unregisterActions(action_names: string[]) {
        this.actions = this.actions.filter(action => !action_names.includes(action.name));
        log.info(`Unregistered actions: ${action_names}`);
    }

    private addContext(message: string, silent: boolean) {
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
        if (this.pendingActionId === null) {
            log.error("Received an action result when there is no pending action");
            return;
        } else if (this.pendingActionId !== message.data.id) {
            log.error("Received an action result with an ID that doesn't match the pending action");
            return;
        }
        let content: any = {
            success: message.data.success
        }
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

    /**
     * Convert an {@link Action} into the OpenAI "tool" format.
     *
     * @param action - An object conforming to the Action interface.
     * @returns A tool object formatted for OpenAI's API.
     */
    private convertActionToTool(action: Action): ChatCompletionTool {
        const {name, description, schema} = action;
        return {
            type: "function",
            function: {
                name,
                description,
                parameters: schema || {},
            },
        };
    }
}

