import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// --- File logging layer ---

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const logFilePath: string = process.env.OPENCLAUDE_LOG
  || path.join(os.homedir(), '.openclaude', 'gateway.log');

let logDirReady = false;

function ensureLogDir(): void {
  if (logDirReady) return;
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    logDirReady = true;
  } catch {
    // silently ignore — file logging will just be skipped
  }
}

function writeToFile(level: string, component: string, msg: string, data?: unknown): void {
  try {
    ensureLogDir();
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component,
      msg: stripAnsi(msg),
    };
    if (data !== undefined) {
      if (data instanceof Error) {
        entry.data = { message: data.message, stack: data.stack };
      } else {
        entry.data = data;
      }
    }
    fs.appendFileSync(logFilePath, JSON.stringify(entry) + '\n');
  } catch {
    // silently ignore file-write errors — never break the process
  }
}

// --- Public API ---

export const logger = {
  debug(component: string, message: string, data?: unknown) {
    if (!shouldLog('debug')) return;
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.blue(`[${component}]`),
      chalk.gray(message),
      data ? chalk.gray(JSON.stringify(data, null, 2)) : '',
    );
    writeToFile('debug', component, message, data);
  },

  info(component: string, message: string, data?: unknown) {
    if (!shouldLog('info')) return;
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.cyan(`[${component}]`),
      message,
      data ? chalk.gray(JSON.stringify(data)) : '',
    );
    writeToFile('info', component, message, data);
  },

  warn(component: string, message: string, data?: unknown) {
    if (!shouldLog('warn')) return;
    console.warn(
      chalk.gray(`[${timestamp()}]`),
      chalk.yellow(`[${component}]`),
      chalk.yellow(message),
      data ? chalk.yellow(JSON.stringify(data)) : '',
    );
    writeToFile('warn', component, message, data);
  },

  error(component: string, message: string, error?: unknown) {
    if (!shouldLog('error')) return;
    console.error(
      chalk.gray(`[${timestamp()}]`),
      chalk.red(`[${component}]`),
      chalk.red(message),
      error instanceof Error ? chalk.red(error.stack || error.message) : error ? chalk.red(String(error)) : '',
    );
    writeToFile('error', component, message, error);
  },

  success(component: string, message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`),
      chalk.green(`[${component}]`),
      chalk.green(message),
    );
    writeToFile('info', component, message);
  },

  getLogPath(): string {
    return logFilePath;
  },
};
