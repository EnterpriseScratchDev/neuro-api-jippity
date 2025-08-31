// Utility functions for state transitions
import {
    ActionMessage,
    ActionResultMessage,
    ContextMessage,
    ForceActionMessage
} from "./api-types";
import { ChatCompletionMessage } from "openai/resources/chat/completions";

export type State =
    | WaitingForGameState
    | IdleState
    | ThinkingState
    | PendingActionState
    | ExitingState;

interface BaseState {
    id: string;
    since: Date;
    game: string;
}

/**
 * Jippity is waiting for the game to start up.
 */
export interface WaitingForGameState extends BaseState {
    id: "state/waiting-for-game-startup";
    game: never;
}

/**
 * Jippity is idle while waiting for a message from the game.
 */
export interface IdleState extends BaseState {
    id: "state/idle";
}

/**
 * A request to the OpenAI API is in progress.
 */
export interface ThinkingState extends BaseState {
    id: "state/thinking";
    trigger?: ContextMessage | ForceActionMessage | ActionResultMessage;
    // Even if the trigger is an ActionResultMessage, we need to know if it was a forced action.
    forceAction?: ForceActionMessage;
}

/**
 * Jippity is waiting for the result of an action.
 */
export interface PendingActionState extends BaseState {
    id: "state/pending-action";
    action: ActionMessage;
    completion: ChatCompletionMessage;
    forceAction?: ForceActionMessage;
}

/**
 * Jippity is talking to the audience.
 *
 * This is currently unused. A future version of Jippity may artificially delay responses to simulate talking.
 */
export interface TalkingState extends BaseState {
    id: "state/talking";
}

/**
 * Jippity is in the process of shutting down.
 */
export interface ExitingState extends BaseState {
    id: "state/exiting";
    reason?: string;
}

// Utility functions for state transitions

export function toWaitingForGameState(): WaitingForGameState {
    return {
        id: "state/waiting-for-game-startup",
        since: new Date(),
        game: undefined as never
    };
}

export function toIdleState(prev: { game: string }): IdleState {
    return {
        id: "state/idle",
        since: new Date(),
        game: prev.game
    };
}

export function toThinkingState(
    prev: { game: string },
    trigger?: ContextMessage | ForceActionMessage | ActionResultMessage,
    forceAction?: ForceActionMessage
): ThinkingState {
    if (trigger && trigger.command === "actions/force" && !forceAction) {
        forceAction = trigger;
    }
    return {
        id: "state/thinking",
        since: new Date(),
        game: prev.game,
        trigger,
        forceAction
    } as ThinkingState;
}

export function toPendingActionState(
    prev: { game: string },
    action: ActionMessage,
    completion: ChatCompletionMessage,
    forceAction?: ForceActionMessage
): PendingActionState {
    return {
        id: "state/pending-action",
        since: new Date(),
        game: prev.game,
        action,
        completion,
        forceAction
    };
}

export type ReactionMessage = ContextMessage | ForceActionMessage;

export interface IdleTimerStimulus {
    type: "IdleTimer";
}

// Stimulus received when a non-silent context message
// or a force action message is received
export interface MessageStimulus {
    type: "Message";
    message: ReactionMessage;
}

export type Stimulus = IdleTimerStimulus | MessageStimulus;

export function isIdleTimerStimulus(stimulus: Stimulus): stimulus is IdleTimerStimulus {
    return stimulus.type === "IdleTimer";
}

export function isMessageStimulus(stimulus: Stimulus): stimulus is MessageStimulus {
    return stimulus.type === "Message";
}
