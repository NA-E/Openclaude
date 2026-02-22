# Architecture

Detailed architecture documentation for OpenClaude.

## System Overview

OpenClaude is a multi-agent AI assistant framework with the following major subsystems:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Gateway Server                              │
│  (WebSocket + HTTP on ws://127.0.0.1:18789)                        │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────────────┐  │
│  │ WebSocket│ │   HTTP   │ │   Session    │ │  Channel Router   │  │
│  │  Server  │ │  Routes  │ │  Manager     │ │  (Adapter Dspch)  │  │
│  └──────────┘ └──────────┘ └──────────────┘ └───────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                  Agent Orchestrator                           │   │
│  │  ┌─────────────┐  ┌────────────┐  ┌───────────────────────┐ │   │
│  │  │ Claude SDK  │  │  Tool Loop │  │  System Prompt Builder│ │   │
│  │  │ (Anthropic) │  │ (10 iters) │  │  (SOUL + Memory +    │ │   │
│  │  │             │  │            │  │   Skills)             │ │   │
│  │  └─────────────┘  └────────────┘  └───────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────── Mission Control ─────────────────┐   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌─────────┐ │   │
│  │  │  Database  │  │  Heartbeat │  │ Notific. │  │ Standup │ │   │
│  │  │  (6 table) │  │  System    │  │ Daemon   │  │ Gen.    │ │   │
│  │  └────────────┘  └────────────┘  └──────────┘  └─────────┘ │   │
│  │  ┌────────────┐  ┌────────────┐                             │   │
│  │  │ Squad Mgr  │  │ MC Tools   │                             │   │
│  │  │ (10 agents)│  │ (8 tools)  │                             │   │
│  │  └────────────┘  └────────────┘                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌───────┐ ┌────────┐ ┌──────────┐ ┌─────────┐ ┌───────────────┐  │
│  │Memory │ │ Skills │ │Scheduler │ │ Browser │ │ Memory Stack  │  │
│  │ Store │ │Registry│ │ (Cron)   │ │ Control │ │ (WORKING.md)  │  │
│  └───────┘ └────────┘ └──────────┘ └─────────┘ └───────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
         │           │           │            │
    ┌────┴──┐  ┌─────┴──┐  ┌────┴───┐  ┌─────┴──┐
    │Discord│  │Telegram│  │ Slack  │  │WebChat │
    │Adapter│  │Adapter │  │Adapter │  │Adapter │
    └───────┘  └────────┘  └────────┘  └────────┘
```

## Subsystem Details

### 1. Gateway (`src/gateway/server.ts`)

The central hub. Everything flows through here.

**Responsibilities:**
- Create and wire all subsystems
- HTTP REST API (core + Mission Control endpoints)
- WebSocket for real-time events
- Route inbound messages to the agent orchestrator
- DM pairing security enforcement
- Broadcast events to connected dashboard clients

**Key Methods:**
- `constructor()` — Creates all subsystems, wires them together
- `handleInbound()` — Main message processing pipeline
- `setupHTTPRoutes()` — Core REST endpoints
- `setupMissionControlRoutes()` — MC-specific endpoints
- `start()` — Initialize squad, connect channels, start heartbeats
- `stop()` — Graceful shutdown of all subsystems

### 2. Agent Orchestrator (`src/agent/orchestrator.ts`)

The AI brain. Manages Claude API calls and tool execution.

**Responsibilities:**
- Maintain agent registry (default + 10 squad agents)
- Build system prompts from SOUL.md, memories, and skills
- Execute Claude API calls with tool_use loop
- Dispatch tool calls to built-in tools, MC tools, or skill tools
- Handle heartbeat processing for scheduled wakeups
- Enable agent-to-agent messaging

**Tool Execution Flow:**
```
Claude API response
    ↓
For each content block:
    ├── text → collect as response
    └── tool_use →
        ├── mc_* prefix → executeMCTool() (Mission Control)
        ├── shell_exec, file_*, memory_* → executeToolCall() (built-in)
        └── other → skillRegistry.findTool() (skill tools)
            ↓
        Add tool_result to messages
        ↓
        Loop back to Claude API (up to 10 iterations)
```

### 3. Session Manager (`src/gateway/sessions.ts`)

Isolates conversations per sender, channel, and agent.

**Session Types:**
- `main` — Direct messages (1:1 with user)
- `group` — Group chats (activated by mention)
- `agent-to-agent` — Inter-agent communication

**Key Features:**
- Session key format: `dm:{channelType}:{senderId}` or `group:{channelType}:{groupId}`
- DM pairing: unknown senders get a 6-char code to verify
- Message history kept to last 200 per session

### 4. Channel Router (`src/gateway/router.ts`)

Pluggable adapter system for messaging platforms.

**Adapter Interface:**
```typescript
interface ChannelAdapter {
  type: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: (message: InboundMessage) => void): void;
  getStatus(): Channel['status'];
}
```

Adapters convert platform-specific messages to/from `InboundMessage`/`OutboundMessage`.

### 5. Mission Control Database (`src/mission-control/database.ts`)

Shared brain for the agent squad. 6 tables:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `agents` | Squad members | name, role, sessionKey, status, level |
| `tasks` | Work items | title, status (6 states), assigneeIds, priority |
| `messages` | Task comments | taskId, fromAgentId, content, mentions |
| `activities` | Audit trail | type, agentId, message, timestamp |
| `documents` | Deliverables | title, content (markdown), type, taskId |
| `notifications` | @mentions | mentionedAgentId, content, delivered |

**Thread Subscriptions:** When an agent comments on a task, all previous commenters and assignees get notified of future comments (no @mention needed).

### 6. Heartbeat System (`src/mission-control/heartbeat.ts`)

Wakes agents periodically on staggered schedules.

**Schedule (every 15 minutes, staggered):**
```
:00 Pepper    :07 Wanda     :13 Wong
:02 Shuri     :08 Vision    :14 Jarvis
:04 Friday    :10 Fury
:06 Loki      :12 Quill
```

**Heartbeat Protocol:**
1. Load WORKING.md → current task state
2. Check undelivered notifications
3. Get assigned tasks from database
4. Scan activity feed
5. Build contextual prompt
6. Call `orchestrator.processHeartbeat()`
7. If no work: `HEARTBEAT_OK`

### 7. Memory Stack (`src/mission-control/memory-stack.ts`)

Per-agent persistent memory across sessions.

**Layers:**
```
WORKING.md      ← Current task state (read first on every wakeup)
YYYY-MM-DD.md   ← Daily raw logs (append during work)
MEMORY.md       ← Curated long-term memory (key decisions, lessons)
HEARTBEAT.md    ← Wake-up checklist
```

Files are stored in `~/.openclaude/workspace/memory/{agent-session-key}/`.

### 8. Notification Daemon (`src/notifications/daemon.ts`)

Delivers @mentions and thread subscription notifications.

- Polls every 2 seconds for undelivered notifications
- If agent is asleep (status != active), notification stays queued
- On next heartbeat when agent wakes, daemon delivers queued notifications
- Supports `@AgentName` and `@all` syntax

### 9. Skill Registry (`src/skills/registry.ts`)

Loads and manages markdown-defined skills.

**Skill Format (SKILL.md):**
```markdown
# Skill Name

## Description
What this skill does.

- **Version**: 1.0.0
- **Author**: Author Name

## Tools
- `tool_name`: Tool description

## Prompt
Additional context injected into the agent's system prompt.
```

Skills are loaded from:
1. `{workspace}/skills/` — User-installed skills
2. `{cwd}/skills/` — Bundled skills

### 10. Tools (`src/tools/executor.ts`)

Built-in tool definitions and execution:

| Tool | Description | Sandbox Safe |
|------|-------------|:---:|
| `shell_exec` | Run shell commands | No |
| `file_read` | Read files | Yes |
| `file_write` | Write files | Yes |
| `file_list` | List directory | Yes |
| `memory_remember` | Store in memory | Yes |
| `memory_recall` | Search memory | Yes |
| `sessions_list` | List sessions | Yes |
| `sessions_send` | Inter-agent msg | Yes |

**Mission Control Tools** (8 additional, all prefixed `mc_`):

| Tool | Description |
|------|-------------|
| `mc_task_create` | Create task, assign agents |
| `mc_task_update` | Change task status |
| `mc_task_list` | Query tasks |
| `mc_comment` | Post comment with @mentions |
| `mc_document_create` | Create deliverable/research doc |
| `mc_activity_feed` | Read activity stream |
| `mc_agent_list` | List all agents with status |
| `mc_send_message` | DM another agent |

## Data Storage

All data is file-based (local-first):

```
~/.openclaude/
├── openclaude.json              ← Configuration
├── workspace/
│   ├── memory/
│   │   ├── agent-main-main/     ← Jarvis's memory files
│   │   ├── agent-product-analyst-main/ ← Shuri's memory
│   │   └── ...                  ← Each agent has own directory
│   └── skills/                  ← User-installed skills
├── mission-control/
│   └── mission-control.json     ← Shared MC database
└── memory/
    └── memories.json            ← Quick memory store
```

## API Surface

### Core REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/status` | System status |
| GET | `/api/sessions` | List all sessions |
| POST | `/api/message` | Send message to agent |
| GET | `/api/agents` | List agent configs |
| GET | `/api/skills` | List skills |
| GET | `/api/channels` | Channel statuses |

### Mission Control Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mc/stats` | Dashboard statistics |
| GET | `/api/mc/agents` | Squad member list |
| GET/POST | `/api/mc/tasks` | Task CRUD |
| PATCH | `/api/mc/tasks/:id` | Update task |
| GET/POST | `/api/mc/tasks/:id/messages` | Task comments |
| GET | `/api/mc/activities` | Activity feed |
| GET/POST | `/api/mc/documents` | Document CRUD |
| GET | `/api/mc/notifications` | Pending notifications |
| GET | `/api/mc/heartbeat` | Heartbeat schedule |
| POST | `/api/mc/standup` | Trigger daily standup |

### WebSocket Events

| Event | Direction | Data |
|-------|-----------|------|
| `message.inbound` | Server → Client | InboundMessage |
| `message.outbound` | Server → Client | OutboundMessage |
| `agent.thinking` | Server → Client | agentId, sessionId |
| `agent.response` | Server → Client | agentId, sessionId, content |
| `agent.tool_use` | Server → Client | agentId, tool, input |
| `agent.error` | Server → Client | agentId, error |
| `system.status` | Both | SystemStatus |
| `session.created` | Server → Client | session |
| `scheduler.fired` | Server → Client | task |

## Security Model

1. **DM Pairing** (`DM_POLICY=pairing`): Unknown senders get a 6-char code. Owner must approve via `/api/approve/:code`.
2. **Sandbox Mode** (`SANDBOX_MODE=true`): Disables `shell_exec` tool.
3. **Per-Channel Allowlists**: Discord/Telegram adapters check user IDs against `ALLOWED_USERS`.
4. **Command Sanitization**: Built-in blocklist for dangerous shell commands.
5. **Gateway Secret**: API auth (placeholder, needs production implementation).
