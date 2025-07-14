import winston from "winston";

const logLevel = process.env.LOG_LEVEL ?? "info";

export const log = winston.createLogger({
    level: logLevel,
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3
    },
    transports: [new winston.transports.Console()],
    // format: winston.format.combine(
    //     winston.format.printf(info => {
    //         return util.format("[%s] %s", info.level.toUpperCase().padEnd(5), info.message)
    //     })
    // )
    format: winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.cli()
        // winston.format.json(),
        // winston.format.prettyPrint({colorize: true})
    )
});
