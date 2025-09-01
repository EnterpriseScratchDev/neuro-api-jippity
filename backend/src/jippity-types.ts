// Utility functions for state transitions
import { ContextMessage, ForceActionMessage } from "./api-types";

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
