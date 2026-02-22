/**
 * Mission Control Tools — Agent-facing tools for interacting with the shared database.
 *
 * From the article:
 * "Agents interact with this via CLI commands:
 *  npx convex run messages:create, documents:create, tasks:update"
 *
 * We expose these as Claude tool_use definitions so agents can
 * create tasks, post comments, update statuses, and create documents.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MissionControlDB, TaskStatus, DocumentType } from './database.js';
import { NotificationDaemon } from '../notifications/daemon.js';
import { logger } from '../utils/logger.js';

export function buildMissionControlTools(): Anthropic.Messages.Tool[] {
  return [
    {
      name: 'mc_task_create',
      description: 'Create a new task in Mission Control. Assign it to agents by name.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Detailed task description' },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Agent names to assign (e.g., ["Vision", "Loki"])',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Task priority',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorization',
          },
        },
        required: ['title', 'description'],
      },
    },
    {
      name: 'mc_task_update',
      description: 'Update a task status or details in Mission Control.',
      input_schema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID to update' },
          status: {
            type: 'string',
            enum: ['inbox', 'assigned', 'in_progress', 'review', 'done', 'blocked'],
            description: 'New status',
          },
          title: { type: 'string', description: 'Updated title (optional)' },
          description: { type: 'string', description: 'Updated description (optional)' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'mc_task_list',
      description: 'List tasks from Mission Control, optionally filtered by status.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['inbox', 'assigned', 'in_progress', 'review', 'done', 'blocked', 'all'],
            description: 'Filter by status (default: all non-done)',
          },
          assignee: { type: 'string', description: 'Filter by agent name' },
        },
      },
    },
    {
      name: 'mc_comment',
      description: 'Post a comment on a task in Mission Control. Use @AgentName to mention agents.',
      input_schema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID to comment on' },
          content: { type: 'string', description: 'Comment text. Use @Name to mention agents.' },
        },
        required: ['taskId', 'content'],
      },
    },
    {
      name: 'mc_document_create',
      description: 'Create a document (deliverable, research, protocol) in Mission Control.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Document title' },
          content: { type: 'string', description: 'Document content (markdown)' },
          type: {
            type: 'string',
            enum: ['deliverable', 'research', 'protocol', 'reference', 'draft'],
            description: 'Document type',
          },
          taskId: { type: 'string', description: 'Associated task ID (optional)' },
        },
        required: ['title', 'content', 'type'],
      },
    },
    {
      name: 'mc_activity_feed',
      description: 'Get the recent activity feed from Mission Control.',
      input_schema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Number of activities to return (default 20)' },
        },
      },
    },
    {
      name: 'mc_agent_list',
      description: 'List all agents in the squad with their status and current tasks.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'mc_send_message',
      description: 'Send a direct message to another agent via @mention.',
      input_schema: {
        type: 'object' as const,
        properties: {
          targetAgent: { type: 'string', description: 'Target agent name' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['targetAgent', 'message'],
      },
    },
  ];
}

/**
 * Execute a Mission Control tool call.
 */
export function executeMCTool(
  name: string,
  input: Record<string, unknown>,
  agentSessionKey: string,
  db: MissionControlDB,
): string {
  const callingAgent = db.getAgentBySessionKey(agentSessionKey);
  const callingAgentId = callingAgent?.id || 'unknown';
  const allAgents = db.listAgents();
  const agentNames = allAgents.map((a) => a.name);

  try {
    switch (name) {
      case 'mc_task_create': {
        const assigneeNames = (input.assignees as string[]) || [];
        const assigneeIds = assigneeNames
          .map((name) => allAgents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id)
          .filter(Boolean) as string[];

        const task = db.createTask({
          title: input.title as string,
          description: input.description as string,
          status: assigneeIds.length > 0 ? 'assigned' : 'inbox',
          priority: (input.priority as 'low' | 'medium' | 'high' | 'urgent') || 'medium',
          assigneeIds,
          creatorId: callingAgentId,
          parentTaskId: null,
          tags: (input.tags as string[]) || [],
          dueDate: null,
        });

        return `Task created: "${task.title}" (${task.id})\nStatus: ${task.status}\nAssigned to: ${assigneeNames.join(', ') || 'unassigned'}`;
      }

      case 'mc_task_update': {
        const updates: Record<string, unknown> = {};
        if (input.status) updates.status = input.status;
        if (input.title) updates.title = input.title;
        if (input.description) updates.description = input.description;

        const task = db.updateTask(input.taskId as string, updates, callingAgentId);
        if (!task) return `Error: Task ${input.taskId} not found`;
        return `Task updated: "${task.title}" → ${task.status}`;
      }

      case 'mc_task_list': {
        const statusFilter = input.status as string;
        const assigneeName = input.assignee as string;
        let assigneeId: string | undefined;
        if (assigneeName) {
          assigneeId = allAgents.find((a) => a.name.toLowerCase() === assigneeName.toLowerCase())?.id;
        }

        const tasks = db.listTasks({
          status: statusFilter && statusFilter !== 'all' ? statusFilter as TaskStatus : undefined,
          assigneeId,
        }).filter((t) => statusFilter === 'all' || statusFilter === 'done' || t.status !== 'done');

        if (tasks.length === 0) return 'No tasks found matching filter.';

        return tasks.map((t) => {
          const assignees = t.assigneeIds
            .map((id) => allAgents.find((a) => a.id === id)?.name || id)
            .join(', ');
          return `[${t.status.toUpperCase()}] ${t.title} (${t.id})\n  Assigned: ${assignees || 'none'}\n  Priority: ${t.priority}`;
        }).join('\n\n');
      }

      case 'mc_comment': {
        const content = input.content as string;
        const mentions = NotificationDaemon.parseMentions(content, agentNames);
        const mentionIds = mentions
          .map((name) => allAgents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id)
          .filter(Boolean) as string[];

        const message = db.createMessage({
          taskId: input.taskId as string,
          fromAgentId: callingAgentId,
          content,
          attachments: [],
          mentions: mentionIds,
        });

        const task = db.getTask(input.taskId as string);
        return `Comment posted on "${task?.title || input.taskId}"\n${mentions.length > 0 ? `Mentioned: ${mentions.join(', ')}` : ''}`;
      }

      case 'mc_document_create': {
        const doc = db.createDocument({
          title: input.title as string,
          content: input.content as string,
          type: input.type as DocumentType,
          taskId: (input.taskId as string) || null,
          authorId: callingAgentId,
        });
        return `Document created: "${doc.title}" (${doc.id})\nType: ${doc.type}`;
      }

      case 'mc_activity_feed': {
        const limit = (input.limit as number) || 20;
        const activities = db.getActivities(limit);
        if (activities.length === 0) return 'No recent activity.';
        return activities.map((a) => {
          const agent = db.getAgent(a.agentId);
          const time = new Date(a.createdAt).toISOString().slice(11, 16);
          return `[${time}] ${agent?.name || a.agentId}: ${a.message}`;
        }).join('\n');
      }

      case 'mc_agent_list': {
        return allAgents.map((a) => {
          const tasks = db.listTasks({ assigneeId: a.id }).filter((t) => t.status !== 'done');
          return `${a.name} (${a.role})\n  Status: ${a.status} | Level: ${a.level}\n  Tasks: ${tasks.length} active\n  Last heartbeat: ${a.lastHeartbeat || 'never'}`;
        }).join('\n\n');
      }

      case 'mc_send_message': {
        const target = allAgents.find(
          (a) => a.name.toLowerCase() === (input.targetAgent as string).toLowerCase(),
        );
        if (!target) return `Error: Agent "${input.targetAgent}" not found`;

        db.createNotification({
          mentionedAgentId: target.id,
          fromAgentId: callingAgentId,
          taskId: null,
          content: `Direct message from ${callingAgent?.name || 'unknown'}: ${input.message as string}`,
          delivered: false,
        });

        return `Message queued for ${target.name}. Will be delivered on their next heartbeat.`;
      }

      default:
        return `Unknown Mission Control tool: ${name}`;
    }
  } catch (err) {
    logger.error('MCTools', `Error executing ${name}`, err);
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
