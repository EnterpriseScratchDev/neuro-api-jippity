import {RawData, WebSocket, WebSocketServer} from "ws";
import util from "util";
import assert from "node:assert";
import {
    Action,
    ActionMessage,
    ActionResultMessage,
    deserializeMessage,
    Message,
    validateActionSchema
} from "./api-types";
import OpenAI from "openai";
import {log} from "./logging";
import {ChatCompletionMessageParam, ChatCompletionTool} from "openai/resources/chat/completions";

// ***************************
// * OpenAI API Client Setup *
// ***************************
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini"

// If true, then no other requests to OpenAI will be made
// This is the closest thing I could find to a mutex lock
// Who knew JavaScript was single-threaded? Not me.
let openaiRequestInProgress = false;

// The initial "system" message seen by the AI
// Feel free to edit this to change
const systemMessage: ChatCompletionMessageParam = {
    "role": "system",
    "content": [
        {
            "type": "text",
            "text": "You are Jippity, an artificial intelligence designed to play video games on a livestream.\n" +
                "The messages you receive contain information about what's happening in the game." +
                "You will use function calls to perform game actions. " +
                "Do not attempt to make in-game actions in your text responses. " +
                "Remember that you are the one playing the game, not the audience.\n" +
                "\n" +
                "If you don't have any functions available or in-game actions you want to take, you can talk about your half-brother Randy and your cousin Neuro-sama." +
                "If you are feeling lonely because no one is talking in chat, you can make up stories about Randy and Neuro." +
                "Try to limit your monologues to a few sentences at a time."
        }
    ]
}

// ******************************
// * AI and Game State Tracking *
// ******************************

// Stores the state of the game and the AI
class JippityState {
    isStarted: boolean;
    game: string | undefined;
    actions: Action[];
    openaiMessages: ChatCompletionMessageParam[];
    pendingActionId: string | null;

    constructor() {
        this.isStarted = false;
        this.game = undefined;
        this.actions = [];
        this.openaiMessages = [systemMessage];
        this.pendingActionId = null;
    }
}

// Stores the state of the game and the AI
const jippityState = new JippityState();

// The time in milliseconds between activations of calls to OpenAI
// Defaults to 10 seconds, enforces a minimum of 1 second for the sake of your wallet
const jippityIntervalMs = Math.max(
    parseInt(process.env.JIPPITY_INTERVAL_MS ?? "", 10) || 10_000,
    1_000);

// *********************************************
// * WebSocketServer and WebSocket connections *
// *********************************************

const wssPort = parseInt(process.env.WSS_PORT ?? "", 10) || 8000;
const wss = new WebSocketServer({port: wssPort});

// Array of active WebSocket connections
let wsConnections: WebSocket[] = [];

wss.on("listening", () => {
    log.info(`WebSocketServer listening on port ${wssPort}`);
});

wss.on("error", error => {
    log.error("WebSocketServer error", error);
})

wss.on("connection", ws => {
    // Store the WebSocket connection
    wsConnections.push(ws);
    log.info(`New WebSocket connection; there are now ${wsConnections.length} connections`);

    ws.on("close", (code, reason) => {
        wsConnections = wsConnections.filter(x => x !== ws);
        log.info(`WebSocket connection closed; code: ${code}, reason: \"${reason}\"; there are now ${wsConnections.length} connections`);
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            log.error("WebSocket received a message with binary data; the server (Neuro) can only handle text");
            return;
        }
        const dataStr = data.toString();
        log.debug(`Message received: ${util.inspect(dataStr)}`);
        try {
            handleMessage(dataStr);
        } catch (e) {
            log.error("Error thrown from handleMessage", e);
            return;
        }
    })
});

// ********************************
// * Message and Command Handlers *
// ********************************

function handleMessage(dataStr: string): boolean {
    const message = deserializeMessage(dataStr);
    if (message === null) {
        return false;
    }

    if (!jippityState.isStarted && message.command !== "startup") {
        log.warn(`Received "${message.command}" command before receiving a \"startup\" command`);
    }

    switch (message.command) {
        case "startup":
            jippityState.isStarted = true;
            jippityState.game = message.game;
            jippityState.actions = [];
            log.info(`Set game to \"${message.game}\" and cleared all registered actions`);
            const game_started: ChatCompletionMessageParam = {
                role: "user",
                content: `You are now playing ${message.game}`
            };
            jippityState.openaiMessages.push(game_started);
            return true;
        case "actions/register":
            registerActions(message.data.actions);
            return true;
        case "actions/unregister":
            unregisterActions(message.data.action_names);
            return true;
        case "context":
            addContext(message.data.message, message.data.silent);
            return true;
        case "actions/force":
            log.error("Handling of the \"actions/force\" command is not yet implemented");
            return false;
        case "action/result":
            addActionResult(message);
            return true;
        case "action":
            log.error("The \"action\" command should be sent from the server (Neuro) to the client (the game), not the other way around.");
            return false;
    }
}

function registerActions(actions: Action[]) {
    let successfulRegistrations = 0;
    for (const action of actions) {
        if (jippityState.actions.find(x => x.name === action.name)) {
            log.warn(`Attempted to register action "${action.name}" when there is already an action with that name`);
            continue;
        }
        if (!validateActionSchema(action)) {
            log.error(`Attempted to register action "${action.name}" with an invalid schema`);
            continue;
        }
        jippityState.actions.push(action);
        successfulRegistrations++;
    }
    log.info(`Successfully registered ${successfulRegistrations} of ${actions.length} actions`);
}

function unregisterActions(action_names: string[]) {
    jippityState.actions = jippityState.actions.filter(action => !action_names.includes(action.name));
    log.info(`Unregistered actions: ${action_names}`);
}

function addContext(message: string, silent: boolean) {
    const context: ChatCompletionMessageParam = {
        role: "user",
        content: message
    };
    jippityState.openaiMessages.push(context);
    if (!silent) {
        setImmediate(callOpenAI);
    }
}

function addActionResult(message: ActionResultMessage) {
    if (jippityState.pendingActionId === null) {
        log.error("Received an action result when there is no pending action");
        return;
    } else if (jippityState.pendingActionId !== message.data.id) {
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
    jippityState.openaiMessages.push(actionResult);
    jippityState.pendingActionId = null;
    setImmediate(callOpenAI);
}

/**
 * Send a message to all active WebSocket connections.
 * @param message the message to send
 */
function send(message: Message) {
    assert(wsConnections, "send called with wsConnections uninitialized")
    assert(message.command, "Messages must always have a \"command\" property");

    if (wsConnections.length == 0) {
        log.warn("send function called with no active WebSocket connections");
        return;
    }

    const messageStr = JSON.stringify(message);
    for (let ws of wsConnections) {
        ws.send(messageStr, err => {
            if (err) {
                log.error("Error sending message to WebSocket connection", err);
            }
        });
    }
}

/**
 * Convert an {@link Action} into the OpenAI "tool" format.
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
            parameters: schema || {},
        },
    };
}

// **************************
// * Calling the OpenAI API *
// **************************

async function callOpenAI() {
    if (openaiRequestInProgress) {
        log.debug("There is already a request to OpenAI in progress");
        return;
    }
    openaiRequestInProgress = true;
    let tools: ChatCompletionTool[] | undefined = jippityState.actions.map(convertActionToTool);
    if (tools.length === 0) {
        tools = undefined;
    }
    const response = await openai.chat.completions.create({
        model: openaiModel,
        messages: [
            ...jippityState.openaiMessages
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
    });
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
        jippityState.pendingActionId = toolCall.id;
    } else {
        log.error(`OpenAI response finished with the following reason: ${choice.finish_reason}`)
        openaiRequestInProgress = false;
        throw new Error("I should be handling this case but I'm not"); // TODO: Handle this case
    }
    jippityState.openaiMessages.push(choice.message);
    openaiRequestInProgress = false;
}

setInterval(() => {
    if (jippityState.pendingActionId) {
        log.debug("Waiting for action result...");
        return;
    }
    callOpenAI().catch(e => log.error("Error from callOpenAI: ", e))
}, jippityIntervalMs);