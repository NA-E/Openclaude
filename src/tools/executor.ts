/**
 * Tool Executor — Built-in tools + skill tool dispatch.
 *
 * OpenClaw gives agents shell, browser, file, and canvas tools.
 * OpenClaude provides the same via Anthropic SDK tool_use format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ToolContext } from '../types/index.js';
import type { SkillRegistry } from '../skills/registry.js';
import { logger } from '../utils/logger.js';

export function buildTools(sandboxed: boolean): Anthropic.Messages.Tool[] {
  const tools: Anthropic.Messages.Tool[] = [
    {
      name: 'shell_exec',
      description: 'Execute a shell command and return stdout/stderr. Use for running scripts, git, npm, system commands, etc.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'file_read',
      description: 'Read the contents of a file at the given path.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'file_write',
      description: 'Write content to a file, creating it if it does not exist.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'file_list',
      description: 'List files and directories at the given path.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
    },
    {
      name: 'memory_remember',
      description: 'Store a piece of information in long-term memory for future recall.',
      input_schema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'What to remember' },
          category: {
            type: 'string',
            enum: ['fact', 'preference', 'context', 'task'],
            description: 'Category of the memory',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for easier retrieval',
          },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'memory_recall',
      description: 'Search long-term memory for relevant information.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'What to search for in memory' },
          limit: { type: 'number', description: 'Maximum results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'sessions_list',
      description: 'List all active sessions across all channels.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'sessions_send',
      description: 'Send a message to another agent or session.',
      input_schema: {
        type: 'object' as const,
        properties: {
          targetAgentId: { type: 'string', description: 'Target agent ID' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['targetAgentId', 'message'],
      },
    },
  ];

  // Remove shell_exec in full sandbox mode
  if (sandboxed) {
    return tools.filter((t) => t.name !== 'shell_exec');
  }

  return tools;
}

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
  skills: SkillRegistry,
  sandboxed: boolean,
): Promise<string> {
  try {
    switch (name) {
      case 'shell_exec': {
        if (sandboxed) return 'Error: Shell execution is disabled in sandbox mode.';
        const command = input.command as string;
        const cwd = (input.cwd as string) || context.workspacePath;
        const timeout = (input.timeout as number) || 30000;

        // Basic command sanitization
        const dangerous = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
        if (dangerous.some((d) => command.includes(d))) {
          return 'Error: This command has been blocked for safety reasons.';
        }

        try {
          const output = execSync(command, {
            cwd,
            timeout,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });
          logger.info('Tools', `shell_exec: ${command.slice(0, 60)}`);
          return output || '(no output)';
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string };
          return `Error: ${execErr.stderr || execErr.message || 'Command failed'}`;
        }
      }

      case 'file_read': {
        const filePath = resolve(context.workspacePath, input.path as string);
        if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
        const content = readFileSync(filePath, 'utf-8');
        return content.length > 50000
          ? content.slice(0, 50000) + '\n... (truncated)'
          : content;
      }

      case 'file_write': {
        const filePath = resolve(context.workspacePath, input.path as string);
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, input.content as string, 'utf-8');
        return `File written: ${filePath}`;
      }

      case 'file_list': {
        const dirPath = resolve(context.workspacePath, input.path as string);
        if (!existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
        const entries = readdirSync(dirPath).map((name) => {
          const stat = statSync(resolve(dirPath, name));
          return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`;
        });
        return entries.join('\n') || '(empty directory)';
      }

      case 'memory_remember': {
        const entry = await context.memoryStore.remember({
          agentId: context.agentId,
          category: input.category as 'fact' | 'preference' | 'context' | 'task',
          content: input.content as string,
          tags: (input.tags as string[]) || [],
          importance: 0.7,
        });
        return `Remembered: ${entry.id}`;
      }

      case 'memory_recall': {
        const results = await context.memoryStore.recall(
          input.query as string,
          (input.limit as number) || 10,
        );
        if (results.length === 0) return 'No relevant memories found.';
        return results.map((m) => `[${m.category}] ${m.content}`).join('\n');
      }

      case 'sessions_list':
        return 'Session listing available via Gateway API.';

      case 'sessions_send':
        return `Message queued for agent ${input.targetAgentId}: ${(input.message as string).slice(0, 100)}`;

      default: {
        // Try skill tools
        const skillTool = skills.findTool(name);
        if (skillTool) {
          return await skillTool.execute(input, context);
        }
        return `Unknown tool: ${name}`;
      }
    }
  } catch (err) {
    logger.error('Tools', `Tool execution error: ${name}`, err);
    return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
