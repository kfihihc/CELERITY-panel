const winston = require('winston');
const path = require('path');

// Формат для файлов (без цветов)
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
    })
);

// Формат для консоли (с цветами и временем)
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        const colors = {
            error: '\x1b[31m',   // красный
            warn: '\x1b[33m',    // жёлтый
            info: '\x1b[36m',    // голубой
            debug: '\x1b[90m',   // серый
        };
        const reset = '\x1b[0m';
        const color = colors[level] || '';
        return `\x1b[90m${timestamp}${reset} ${color}[${level.toUpperCase()}]${reset}: ${stack || message}`;
    })
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
        // Консоль (с цветами и коротким временем)
        new winston.transports.Console({
            format: consoleFormat
        }),
        // Файл с ошибками
        new winston.transports.File({
            filename: path.join(__dirname, '../../logs/error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        // Общий лог
        new winston.transports.File({
            filename: path.join(__dirname, '../../logs/combined.log'),
            format: fileFormat,
            maxsize: 5242880,
            maxFiles: 5,
        }),
    ],
});

module.exports = logger;



