import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  debug(component: string, message: string, data?: unknown) {
    if (!shouldLog('debug')) return;
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.blue(`[${component}]`),
      chalk.gray(message),
      data ? chalk.gray(JSON.stringify(data, null, 2)) : '',
    );
  },

  info(component: string, message: string, data?: unknown) {
    if (!shouldLog('info')) return;
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.cyan(`[${component}]`),
      message,
      data ? chalk.gray(JSON.stringify(data)) : '',
    );
  },

  warn(component: string, message: string, data?: unknown) {
    if (!shouldLog('warn')) return;
    console.warn(
      chalk.gray(`[${timestamp()}]`),
      chalk.yellow(`[${component}]`),
      chalk.yellow(message),
      data ? chalk.yellow(JSON.stringify(data)) : '',
    );
  },

  error(component: string, message: string, error?: unknown) {
    if (!shouldLog('error')) return;
    console.error(
      chalk.gray(`[${timestamp()}]`),
      chalk.red(`[${component}]`),
      chalk.red(message),
      error instanceof Error ? chalk.red(error.stack || error.message) : error ? chalk.red(String(error)) : '',
    );
  },

  success(component: string, message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.green(`[${component}]`),
      chalk.green(message),
    );
  },
};
