import winston from 'winston';
import { emitLog } from '../server';
import { Writable } from 'stream';
import { Logger as PinoLogger } from 'pino';

// Create a custom writable stream
const dashboardStream = new Writable({
    write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const logEntry = JSON.parse(chunk.toString());
        emitLog(logEntry.level, logEntry.message, logEntry.data);
        callback();
    }
});

const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        }),
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Stream({ stream: dashboardStream })
    ]
});

// Create Pino-compatible interface
export const logger = winstonLogger as unknown as PinoLogger;
