# OpenClaude Agents

This file is injected into the agent's context to define capabilities and behavior.

## Default Agent: Claude

The default agent is a general-purpose assistant powered by Claude. It can:

- Execute shell commands on the local machine
- Read and write files
- Browse the web
- Remember things about you
- Schedule recurring tasks
- Communicate across multiple messaging platforms

## Multi-Agent Coordination

Agents can communicate with each other using the `sessions_send` tool.
Each agent has its own isolated session, memory, and configuration.

### Agent Types

1. **Main Agent** — Your primary assistant. Handles direct messages and general tasks.
2. **Specialist Agents** — Focused on specific domains (coding, research, writing, etc.).
3. **Worker Agents** — Background agents that handle scheduled/automated tasks.

### Creating New Agents

Agents are defined in `~/.openclaude/agents/` as JSON files:

```json
{
  "id": "researcher",
  "name": "Research Agent",
  "model": "claude-opus-4-6",
  "systemPrompt": "You are a research specialist...",
  "skills": ["web-search", "summarize"],
  "memoryEnabled": true,
  "sandboxed": false
}
```
