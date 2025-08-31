// Load environment variables from .env file
import "dotenv/config";

import { RawData, WebSocket, WebSocketServer } from "ws";
import util from "util";
import assert from "node:assert";
import { deserializeMessage, Message } from "./api-types";
import OpenAI from "openai";
import { log } from "./logging";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { Jippity } from "./jippity";

// ***************************
// * OpenAI API Client Setup *
// ***************************
// Configured using the following environment variables:
// OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_ORG_ID, and OPENAI_PROJECT_ID
export const openai = new OpenAI();
export const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

// The initial "system" message seen by the AI
// Feel free to edit this to change
export const SYSTEM_MESSAGE: ChatCompletionMessageParam = {
    role: "system",
    content: [
        {
            type: "text",
            text:
                "You are Jippity, an artificial intelligence designed to play video games on a livestream.\n" +
                "The messages you receive contain information about what's happening in the game. " +
                "You will use function calls to perform game actions. " +
                "Do not attempt to make in-game actions in your text responses. " +
                "Remember that you are the one playing the game, not the audience.\n" +
                "\n" +
                "If you don't have any functions available or in-game actions you want to take, you can talk about your half-brother Randy and your cousin Neuro-sama. " +
                "If you are feeling lonely because no one is talking in chat, you can make up stories about Randy and Neuro. " +
                "Try to limit your monologues to a few sentences at a time. " +
                "Avoid using line-breaks and non-ASCII characters in your speech."
        }
    ]
};

// Stores the state of the game and the AI
const jippity = new Jippity();
jippity.startMainLoop().then(() => {
    log.info("Jippity main loop has exited");
});

// *********************************************
// * WebSocketServer and WebSocket connections *
// *********************************************

const wssPort = parseInt(process.env.WSS_PORT ?? "", 10) || 8000;
const wss = new WebSocketServer({ port: wssPort });

// Array of active WebSocket connections
let wsConnections: WebSocket[] = [];

wss.on("listening", () => {
    log.info(`WebSocketServer listening on port ${wssPort}`);
});

wss.on("error", (error) => {
    log.error("WebSocketServer error", error);
});

wss.on("connection", (ws) => {
    // Store the WebSocket connection
    wsConnections.push(ws);
    log.info(`New WebSocket connection; there are now ${wsConnections.length} connections`);

    ws.on("close", (code, reason) => {
        wsConnections = wsConnections.filter((x) => x !== ws);
        log.info(
            `WebSocket connection closed; code: ${code}, reason: "${reason}"; there are now ${wsConnections.length} connections`
        );
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            log.error(
                "WebSocket received a message with binary data; the server (Neuro) can only handle text"
            );
            return;
        }
        const dataStr = data.toString();
        log.debug(`Message received: ${util.inspect(dataStr)}`);
        let message: Message;
        try {
            message = deserializeMessage(dataStr);
        } catch (e) {
            log.error(`Failed to deserialize message: ${e}`);
            return;
        }
        try {
            jippity.onMessageReceived(message);
        } catch (e) {
            log.error("Error thrown from jippity.onMessageReceived", e);
            return;
        }
    });

    ws.on("error", (error) => {
        log.error("WebSocket error", error);
    });
});

/**
 * Send a message to all active WebSocket connections.
 * @param message the message to send
 *
 * **Note**: Errors sending messages are logged, but errors are not thrown.
 */
export function send(message: Message) {
    assert(wsConnections, "send called with wsConnections uninitialized");
    assert(message.command, 'Messages must always have a "command" property');

    if (wsConnections.length == 0) {
        log.warn("send function called with no active WebSocket connections");
        return;
    }

    const messageStr = JSON.stringify(message);
    for (const ws of wsConnections) {
        ws.send(messageStr, (err) => {
            if (err) {
                log.error("Error sending message to WebSocket connection", err);
            }
        });
    }
}

// setInterval(() => {
//     if (jippityHandler.pendingActionId) {
//         log.debug("Waiting for action result...");
//         return;
//     }
//     jippityHandler.callOpenAI().catch((e: Error) => log.error("Error from callOpenAI:", e));
// }, jippityIntervalMs);
