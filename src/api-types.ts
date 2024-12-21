import Ajv, { AnySchema, JSONSchemaType, ValidateFunction } from "ajv";
import { log } from "./logging";

const ajv = new Ajv();

// TODO: Warn about using these keywords
// const disallowedSchemaKeywords = [
//     "$anchor", "$comment", "$defs", "$dynamicAnchor", "$dynamicRef", "$id", "$ref", "$schema", "$vocabulary",
//     "additionalProperties", "allOf", "anyOf", "contentEncoding", "contentMediaType", "contentSchema",
//     "dependentRequired", "dependentSchemas", "deprecated", "description", "else", "if", "maxProperties",
//     "minProperties", "not", "oneOf", "patternProperties", "readOnly", "then", "title", "unevaluatedItems",
//     "unevaluatedProperties", "writeOnly"
// ];
// for (const keyword of disallowedSchemaKeywords) {
//     ajv.removeKeyword(keyword);
// }

/**
 * Tagged union type for all message types.
 */
export type Message =
    | StartupMessage
    | ContextMessage
    | RegisterActionsMessage
    | UnregisterActionsMessage
    | ForceActionMessage
    | ActionResultMessage
    | ActionMessage;

/**
 * A registrable command that Neuro can execute whenever she wants.
 */
export interface Action {
    /**
     * The name of the action, which is its unique identifier.
     * This should be a lowercase string, with words separated by underscores or dashes.
     *
     * @example "join_friend_lobby"
     * @example "use_item"
     */
    name: string;
    /**
     * A plaintext description of what this action does.
     * <b>This information will be directly received by Neuro.</b>
     */
    description: string;
    /**
     * A valid simple JSON schema object that describes how the response data should look like.
     * If your action does not have any parameters, you can omit this field or set it to `{}`.
     */
    schema?: AnySchema;
}

const isValidJsonSchema = (schema: AnySchema): boolean => {
    if (ajv.validateSchema(schema) as boolean) {
        return true;
    }
    if (ajv.errors) {
        log.error("Validation failed: ", ajv.errorsText(ajv.errors));
    }
    return false;
};

/** Log validation errors if any */
const logValidationErrors = (validator: ValidateFunction): void => {
    if (validator.errors) {
        log.error(`Validation failed: ${ajv.errorsText(validator.errors, { dataVar: "." })}`);
    }
};

/**
 * Base interface for all messages sent and received by the server.
 */
interface BaseMessage {
    command: string;
}

/**
 * This message should be sent to the server as soon as the game starts, to let Neuro know that the game is running.
 *
 * This message clears all previously registered actions for this game and does initial setup,
 * and as such should be the very first message that you send.
 */
export interface StartupMessage extends BaseMessage {
    command: "startup";
    game: string;
}

/** Schema for {@link StartupMessage} */
const StartupMessageSchema: JSONSchemaType<StartupMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "startup" },
        game: { type: "string" }
    },
    required: ["command", "game"],
    additionalProperties: false
};

/**
 * A message that can be sent to Neuro to provide context on what's happening in the game.
 */
export interface ContextMessage extends BaseMessage {
    command: "context";
    game: string;
    data: {
        /**
         * A plaintext message that describes what is happening in the game.
         *
         * **This information will be directly received by Neuro.**
         */
        message: string;
        /**
         * If `true`, the message will be added to Neuro's context without prompting her to respond to it.
         * If `false`, Neuro *might* respond to the message directly, unless she is busy talking to someone else or to chat.
         */
        silent: boolean;
    };
}

/** Schema for {@link ContextMessage} */
const ContextMessageSchema: JSONSchemaType<ContextMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "context" },
        game: { type: "string" },
        data: {
            type: "object",
            properties: {
                message: { type: "string" },
                silent: { type: "boolean" }
            },
            required: ["message", "silent"],
            additionalProperties: false
        }
    },
    required: ["command", "game", "data"],
    additionalProperties: false
};

/**
 * This message is sent to the server to register one or more actions that Neuro can execute.
 */
export interface RegisterActionsMessage extends BaseMessage {
    command: "actions/register";
    game: string;
    data: {
        /**
         * An array of actions to be registered.
         * If you try to register an action that is already registered, it will be ignored.
         */
        actions: Action[];
    };
}

/** Schema for {@link RegisterActionsMessage} */
const RegisterActionsMessageSchema: JSONSchemaType<RegisterActionsMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "actions/register" },
        game: { type: "string" },
        data: {
            type: "object",
            properties: {
                actions: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                            schema: {
                                type: "object",
                                nullable: true,
                                additionalProperties: true
                            }
                        },
                        required: ["name", "description"],
                        additionalProperties: false
                    }
                }
            },
            required: ["actions"],
            additionalProperties: false
        }
    },
    required: ["command", "game", "data"],
    additionalProperties: false
};

/**
 * This message is sent to the server to unregister one or more actions.
 */
export interface UnregisterActionsMessage extends BaseMessage {
    command: "actions/unregister";
    game: string;
    data: {
        /**
         * The names of the actions to unregister.
         * If an action is not registered, it will be ignored.
         */
        action_names: string[];
    };
}

/** Schema for {@link UnregisterActionsMessage} */
const UnregisterActionsMessageSchema: JSONSchemaType<UnregisterActionsMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "actions/unregister" },
        game: { type: "string" },
        data: {
            type: "object",
            properties: {
                action_names: { type: "array", items: { type: "string" } }
            },
            required: ["action_names"],
            additionalProperties: false
        }
    },
    required: ["command", "game", "data"],
    additionalProperties: false
};

/**
 * This message is sent to the server to force Neuro to execute one of the listed actions as soon as possible.
 * Note that this may take some time if Neuro is already talking.
 *
 * **Neuro can only handle one forced action at a time.
 *   Sending an action force message while another one is in progress will cause problems!**
 */
export interface ForceActionMessage extends BaseMessage {
    command: "actions/force";
    game: string;
    data: {
        /**
         * An arbitrary string that describes the current state of the game.
         * This can be plaintext, JSON, Markdown, or any other format.
         * **This information will be directly received by Neuro.**
         */
        state?: string;
        /**
         * A plaintext message that tells Neuro what she is currently supposed to be doing.
         * **This information will be directly received by Neuro.**
         * @example "It is now your turn. Please perform an action. If you want to use any items, you should use them before picking up the shotgun."
         */
        query: string;
        /**
         * If `false`, the context provided in the `state` and `query` parameters will be remembered by Neuro after the actions force is completed.
         * If `true`, Neuro will only remember it for the duration of the actions force.
         *
         * This defaults to `false`.
         */
        ephemeral_context?: boolean;
        /** The names of the actions that Neuro should choose from. */
        action_names: string[];
    };
}

/** Schema for {@link ForceActionMessage} */
const ForceActionMessageSchema: JSONSchemaType<ForceActionMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "actions/force" },
        game: { type: "string" },
        data: {
            type: "object",
            properties: {
                state: { type: "string", nullable: true },
                query: { type: "string" },
                ephemeral_context: { type: "boolean", nullable: true },
                action_names: { type: "array", items: { type: "string" } }
            },
            required: ["query", "action_names"],
            additionalProperties: false
        }
    },
    required: ["command", "game", "data"],
    additionalProperties: false
};

/**
 * This message needs to be sent as soon as possible after an action is validated, to allow Neuro to continue.
 * <p>
 * Until the client (the game) sends an action result Neuro will just be waiting for the result of her action.
 * Please make sure to send this message as soon as possible.
 * It should usually be sent after validating the action parameters, before it is actually executed in-game.
 */
export interface ActionResultMessage extends BaseMessage {
    command: "action/result";
    game: string;
    data: {
        /**
         * The ID of the action that this result is for.
         * This is grabbed from the action message directly.
         */
        id: string;
        /**
         * Whether the action was successful or not.
         *
         * If this is `false` and this action was forced, Neuro will immediately retry the forced action.
         *
         * Since setting success to `false` will retry the action force if there was one, if the action was not successful,
         * but you don't want it to be retried, you should set success to `true` and provide an error message in the `message` field.
         */
        success: boolean;
        /**
         * A plaintext message that describes what happened when the action was executed.
         * If not successful, this should be an error message.
         * If successful, this can either be empty, or provide a *small* context to Neuro regarding the action she just took.
         *
         * **This information will be directly received by Neuro.**
         * @example "Remember to not share this with anyone."
         */
        message?: string;
    };
}

/** Schema for {@link ActionResultMessage} */
const ActionResultMessageSchema: JSONSchemaType<ActionResultMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "action/result" },
        game: { type: "string" },
        data: {
            type: "object",
            properties: {
                id: { type: "string" },
                success: { type: "boolean" },
                message: { type: "string", nullable: true }
            },
            required: ["id", "success"],
            additionalProperties: false
        }
    },
    required: ["command", "game", "data"],
    additionalProperties: false
};

/**
 * This message is sent by Neuro when she tries to execute an action.
 *
 * You should respond to it with an {@link ActionMessage} as soon as possible.
 */
export interface ActionMessage extends BaseMessage {
    command: "action";
    data: {
        /**
         * A unique ID for the action. You should use it when sending back the action result.
         */
        id: string;
        /**
         * The name of the action that Neuro is trying to execute.
         */
        name: string;
        /**
         * The JSON-stringified data for the action, as sent by Neuro.
         * This *should** be an object that matches the JSON schema you provided when registering the action.
         * If you did not provide a schema, this parameter will usually be `undefined`.
         *
         * The `data` parameter comes directly from Neuro, so there is a chance it might be malformed, contain invalid JSON, or not match the provided schema exactly.
         * You are responsible for validating the JSON and returning an unsuccessful action result if it is invalid.
         */
        data?: string;
    };
}

/** Schema for {@link ActionMessage} */
const ActionMessageSchema: JSONSchemaType<ActionMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "action" },
        data: {
            type: "object",
            properties: {
                id: { type: "string" },
                name: { type: "string" },
                data: { type: "string", nullable: true }
            },
            required: ["id", "name"],
            additionalProperties: false
        }
    },
    required: ["command", "data"],
    additionalProperties: false
};

type MessageTypeMapping = {
    "startup": StartupMessage;
    "context": ContextMessage;
    "actions/register": RegisterActionsMessage;
    "actions/unregister": UnregisterActionsMessage;
    "actions/force": ForceActionMessage;
    "action/result": ActionResultMessage;
    "action": ActionMessage;
};

type MessageType = keyof MessageTypeMapping;

/** Validators */
export const Validators: Record<MessageType, ValidateFunction<BaseMessage>> = {
    "startup": ajv.compile(StartupMessageSchema),
    "context": ajv.compile(ContextMessageSchema),
    "actions/register": ajv.compile(RegisterActionsMessageSchema),
    "actions/unregister": ajv.compile(UnregisterActionsMessageSchema),
    "actions/force": ajv.compile(ForceActionMessageSchema),
    "action/result": ajv.compile(ActionResultMessageSchema),
    "action": ajv.compile(ActionMessageSchema)
};

function validateAndCast<T extends keyof MessageTypeMapping>(
    obj: unknown,
    _command: T,
    validator: ValidateFunction<BaseMessage>
): MessageTypeMapping[T] | null {
    if (validator(obj)) {
        return obj as MessageTypeMapping[T];
    }
    logValidationErrors(validator);
    return null;
}

/**
 * Deserialize a JSON string to a specific message type.
 */
export function deserializeMessage(json: string): Message | null {
    let obj;
    try {
        obj = JSON.parse(json);
    } catch (e) {
        log.error("Message is not valid JSON: ", e);
        return null;
    }

    if (!obj.command) {
        log.error('Message is missing the "command" property');
        return null;
    }

    if (!(obj.command in Validators)) {
        log.error(`Unknown command ${obj.command}`);
        return null;
    }

    const command: MessageType = obj.command as MessageType;
    const validator: ValidateFunction<BaseMessage> = Validators[command];
    return validateAndCast(obj, command, validator);
}

/** Validate an Action's schema property */
export function validateActionSchema(action: Action): boolean {
    if (!action.schema || Object.keys(action.schema).length === 0) {
        // No schema to validate
        return true;
    }
    const valid = isValidJsonSchema(action.schema);
    if (!valid) {
        console.error("Invalid schema:", ajv.errorsText());
    }
    return valid;
}

export class MessageDeserializationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MessageDeserializationError";
    }
}
