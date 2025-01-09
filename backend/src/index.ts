// Load environment variables from .env file
import "dotenv/config";

import { RawData, WebSocket, WebSocketServer } from "ws";
import util from "util";
import assert from "node:assert";
import { Message } from "./api-types";
import OpenAI from "openai";
import { log } from "./logging";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { JippityHandler } from "./jippity-handler";

import { sleep } from "./utils";

// ***************************
// * OpenAI API Client Setup *
// ***************************
export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
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
};

// Stores the state of the game and the AI
const jippityHandler = new JippityHandler();

// The time in milliseconds between activations of calls to OpenAI
// Defaults to 10 seconds, enforces a minimum of 1 second for the sake of your wallet
const jippityIntervalMs = Math.max(
    parseInt(process.env.JIPPITY_INTERVAL_MS ?? "", 10) || 10_000,
    1_000
);

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
        try {
            jippityHandler.receiveMessage(dataStr);
        } catch (e) {
            log.error("Error thrown from handleMessage", e);
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
    assert(message.command, "Messages must always have a \"command\" property");

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

async function main() {
    const idleTime = 5_000;

    while (jippityHandler.state.id !== "state/exiting") {
        switch (jippityHandler.state.id) {
            case "state/thinking":
                log.debug(`Jippity is thinking... (sleeping for ${idleTime / 1000} seconds)`);
                await sleep(idleTime);
                break;
            case "state/waiting-for-game-startup":
                log.debug(`Waiting for game startup... (sleeping for ${idleTime / 1000} seconds)`);
                await sleep(idleTime);
                break;
            case "state/pending-action":
                log.debug(`Waiting for action result... (sleeping for ${idleTime / 1000} seconds)`);
                await sleep(idleTime);
                break;
            case "state/pending-forced-action":
                log.debug(
                    `Waiting for forced action result... (sleeping for ${idleTime / 1000} seconds)`
                );
                await sleep(idleTime);
                break;
            case "state/idle":
                if (jippityHandler.messageQueue.isNotEmpty()) {
                    log.debug("Processing message queue...");
                    jippityHandler.processMessageQueue();
                } else {
                    // TODO: Add a random chance for Jippity to talk
                    log.debug(
                        `Idle... (sleeping for ${idleTime / 1000} seconds then activating the AI)`
                    );
                    await sleep(idleTime);
                    await jippityHandler.callOpenAI();
                }
                break;
            default:
                log.error(`Unhandled state: ${JSON.stringify(jippityHandler.state)}`);
                break;
        }
    }
}

main().then(() => log.info("Main function completed"));
