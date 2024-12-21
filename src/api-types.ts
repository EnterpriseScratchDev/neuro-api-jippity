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
 * Tagged union type for all message types
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

interface BaseMessage {
    command: string;
}

export interface StartupMessage extends BaseMessage {
    command: "startup";
    game: string;
}

const StartupMessageSchema: JSONSchemaType<StartupMessage> = {
    type: "object",
    properties: {
        command: { type: "string", const: "startup" },
        game: { type: "string" }
    },
    required: ["command", "game"],
    additionalProperties: false
};

export interface ContextMessage extends BaseMessage {
    command: "context";
    game: string;
    data: {
        message: string;
        silent: boolean;
    };
}

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

export interface RegisterActionsMessage extends BaseMessage {
    command: "actions/register";
    game: string;
    data: {
        actions: Action[];
    };
}

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

export interface UnregisterActionsMessage extends BaseMessage {
    command: "actions/unregister";
    game: string;
    data: {
        action_names: string[];
    };
}

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

export interface ForceActionMessage extends BaseMessage {
    command: "actions/force";
    game: string;
    data: {
        state?: string;
        query: string;
        ephemeral_context?: boolean; // Defaults to false
        action_names: string[];
    };
}

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

export interface ActionResultMessage extends BaseMessage {
    command: "action/result";
    game: string;
    data: {
        id: string;
        success: boolean;
        message?: string;
    };
}

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

export interface ActionMessage extends BaseMessage {
    command: "action";
    data: {
        id: string;
        name: string;
        data?: string;
    };
}

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
    startup: StartupMessage;
    context: ContextMessage;
    "actions/register": RegisterActionsMessage;
    "actions/unregister": UnregisterActionsMessage;
    "actions/force": ForceActionMessage;
    "action/result": ActionResultMessage;
    action: ActionMessage;
};

type MessageType = keyof MessageTypeMapping;

/** Validators */
export const Validators: Record<MessageType, ValidateFunction<BaseMessage>> = {
    startup: ajv.compile(StartupMessageSchema),
    context: ajv.compile(ContextMessageSchema),
    "actions/register": ajv.compile(RegisterActionsMessageSchema),
    "actions/unregister": ajv.compile(UnregisterActionsMessageSchema),
    "actions/force": ajv.compile(ForceActionMessageSchema),
    "action/result": ajv.compile(ActionResultMessageSchema),
    action: ajv.compile(ActionMessageSchema)
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
