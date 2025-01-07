import { ActionMessage, ForceActionMessage } from "./api-types";

export type State =
    | WaitingForGameState
    | IdleState
    | ThinkingState
    | PendingActionState
    | PendingForcedActionState
    | TalkingState
    | ExitingState;

interface BaseState {
    id: string;
    description?: string;
}

/**
 * Jippity is waiting for the game to start up.
 */
export interface WaitingForGameState {
    id: "state/waiting-for-game-startup";
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
}

/**
 * Jippity is waiting for the result of an action.
 */
export interface PendingActionState extends BaseState {
    id: "state/pending-action";
    action: ActionMessage;
}

/**
 * Jippity is waiting for the result of an action that was forced by the game.
 */
export interface PendingForcedActionState extends BaseState {
    id: "state/pending-forced-action";
    /**
     * The action message Jippity sent to the game
     */
    action: ActionMessage;
    /**
     * The message from the game that forced Jippity to take action.
     *
     * This is tracked because Jippity will need to retry the action if it fails.
     */
    forcedAction: ForceActionMessage;
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
