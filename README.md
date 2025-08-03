# Jippity
Jippity is a tool for testing game integration with the [Neuro-sama Game API](https://github.com/VedalAI/neuro-game-sdk).

Jippity is designed to be a more "realistic" alternative to [Randy](https://github.com/VedalAI/neuro-game-sdk/tree/main/Randy).
He accomplishes this by offloading his thinking to OpenAI, as their models are more intelligent and less reliable than a random number generator.

Jippity has the following advantages over Randy:
- he can intelligently choose to take actions without being forced
- he can choose to not take any actions
- he can send actions with invalid data
- he pretends to be a streamer and is lonely because he has no viewers

If you have any problems with Jippity, please create a GitHub issue or message me on Discord: @EnterpriseScratchDev

> [!WARNING]
> I'm not actively working on this project, but I'll try to address any issues that come up if you create a GitHub issue and/or message me on Discord.
> This project has some jankiness built into it at a foundational level, so please don't expect perfection.

## Installing and Running Jippity
1. Clone or download this repository
2. Run `cd backend` to enter the backend directory
3. Run `npm install` to install dependencies
4. Run `npm start` to start the program

If you are contributing to Jippity, please lint and format your code using `npm run lint` and `npm run format`.

Jippity sends messages to all connected websockets, so a tool like [Insomnia](https://insomnia.rest/) can be used to see what he's sending if there's a problem with your game.

## Configuration Using Environment Variables
This tool is configured exclusively with environment variables.
Environment variables will be loaded from the `.env` file in the backend folder, if present.
A config file may be added in the future.

| Environment Variable  | Description                                                                                                                                     | Required | Example       |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|----------|---------------|
| `OPENAI_API_KEY`      | You OpenAI API key.                                                                                                                             | Yes      | you wish      |
| `OPENAI_MODEL`        | The OpenAI model to use. Must support tools (formerly functions).                                                                               | No       | `gpt-4o-mini` |
| `WSS_PORT`            | The port the websocket server will listen on. Defaults to `8000`.                                                                               | No       | `8000`        |
| `LOG_LEVEL`           | The level of logs to display. The options are `error`, `warn`, `info`, and `debug`.                                                             | No       | `info`        |
| `JIPPITY_INTERVAL_MS` | The interval in milliseconds before Jippity will say/do something unprompted.<br/>Defaults to 10 seconds, has a hard-coded minimum of 1 second. | No       | `10000`       |

## Known Issues
- Old messages are not cleared from the AI's "memory", so the context window will eventually fill up, leading to a crash.
  The token limit is currently hard-coded to 2048.

## Implementation Details
- Multiple websocket clients (i.e. games) can connect to Jippity at the same time.
  Jippity can receive messages from any client and will send messages to all clients.
  This behavior matches Randy.
- There is no guarantee that Jippity will respond to an `actions/force` message in a timely manner.
- When a forced action has a non-success result, Jippity won't necessarily retry it.
  The specification says that Neuro will immediately retry in this scenario.
- The `ephemeral_context` property of force action messages is treated as if it was always `false`.
  This may result in the AI getting confused if its important for context to be hidden after the action is taken.
