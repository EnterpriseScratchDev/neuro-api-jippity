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
> I have very little experience with JavaScript and TypeScript and have likely gone about things the wrong way.
> One look at `index.ts` will be enough to see that I'm a little out of my element.
> Despite that, I'm committed to fixing bugs and otherwise supporting Jippity until at least the end of this year if there is demand for it.

## Installing and Running Jippity
1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm start` to start the program

If you are contributing to Jippity, please lint and format your code using `npm run lint` and `npm run format`.

Jippity sends messages to all connected websockets, so a tool like [Insomnia](https://insomnia.rest/) can be used to see what he's sending if there's a problem with your game.

## Configuration Using Environment Variables
This tool is configured exclusively with environment variables.
Environment variables will be loaded from the `.env` file in the root of this repository, if present.
A config file may be added in the future.

| Environment Variable  | Description                                                                                                                                     | Required | Example       |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|----------|---------------|
| `OPENAI_API_KEY`      | You OpenAI API key.                                                                                                                             | Yes      | you wish      |
| `OPENAI_MODEL`        | The OpenAI model to use. Must support tools (formerly functions).                                                                               | No       | `gpt-4o-mini` |
| `WSS_PORT`            | The port the websocket server will listen on. Defaults to `8000`.                                                                               | No       | `8000`        |
| `LOG_LEVEL`           | The level of logs to display. The options are `error`, `warn`, `info`, and `debug`.                                                             | No       | `info`        |
| `JIPPITY_INTERVAL_MS` | The interval in milliseconds before Jippity will say/do something unprompted.<br/>Defaults to 10 seconds, has a hard-coded minimum of 1 second. | No       | `10000`       |

## Known Issues
- `actions/force` is not implemented. This will be implemented in the very near future.
- Old messages are not cleared from the AI's "memory", so the context window will eventually fill up, leading to a crash.
  The token limit is currently hard-coded to 2048.
- A transitive dependency seemingly used for JSON schema validation is deprecated.
  It's not causing any problems, but it causes a warning to be displayed on startup.
