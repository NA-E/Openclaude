# CLAUDE.md — Project Guide for Claude Code

This is the guide for Claude Code sessions working on OpenClaude.
Read this file first to understand the project, architecture, and how to make changes.

## What Is This Project?

**OpenClaude** is an open-source personal AI assistant inspired by [OpenClaw](https://github.com/openclaw/openclaw), rebuilt from scratch using the Anthropic Claude SDK. It implements the full "Mission Control" architecture from [Bhanu Teja P's viral article](https://x.com/pbteja1998/status/2017495026230775832) — a system where 10 AI agents work together like a real team.

### Key Concept Translation (OpenClaw → OpenClaude)

| OpenClaw | OpenClaude | File |
|----------|-----------|------|
| Gateway (WebSocket control plane) | Same — ws://127.0.0.1:18789 | `src/gateway/server.ts` |
| Pi agent runtime | Anthropic SDK with tool_use | `src/agent/orchestrator.ts` |
| AGENTS.md / SOUL.md / TOOLS.md injection | Same files, same approach | Root-level `.md` files |
| Channel adapters (WhatsApp, Telegram, etc.) | Pluggable adapter pattern | `src/channels/*/adapter.ts` |
| SKILL.md portable skill format | Same markdown-defined skills | `src/skills/registry.ts` |
| Markdown-file memory (local-first) | JSON file store + memory stack | `src/memory/store.ts`, `src/mission-control/memory-stack.ts` |
| Cron heartbeat scheduler | croner-based with staggered wakeups | `src/mission-control/heartbeat.ts` |
| Session isolation + DM pairing | Same | `src/gateway/sessions.ts` |
| Convex database (Mission Control) | Local JSON file DB (same schema) | `src/mission-control/database.ts` |

## Project Structure

```
/home/user/Openclaude/
├── CLAUDE.md                  ← YOU ARE HERE
├── AGENTS.md                  ← Operating manual injected into all agents
├── SOUL.md                    ← Default agent personality
├── TOOLS.md                   ← Tool usage guidelines
├── README.md                  ← User-facing documentation
├── ARCHITECTURE.md            ← Detailed architecture documentation
├── DEVELOPMENT.md             ← Developer guide (how to run, test, extend)
│
├── package.json               ← Node.js deps (TypeScript, Anthropic SDK, etc.)
├── tsconfig.json              ← TypeScript config (ES2022, NodeNext)
├── vitest.config.ts           ← Test configuration
├── Dockerfile                 ← Container build
├── docker-compose.yml         ← Docker orchestration
├── .env.example               ← Environment variable template
│
├── src/
│   ├── cli/
│   │   ├── index.ts           ← CLI entry point (commander)
│   │   └── commands/
│   │       └── doctor.ts      ← Configuration diagnostics
│   │
│   ├── gateway/
│   │   ├── server.ts          ← THE CORE: Gateway class (WS + HTTP + all subsystems)
│   │   ├── sessions.ts        ← Session manager (DM/group/agent-to-agent)
│   │   └── router.ts          ← Channel router (pluggable adapter dispatch)
│   │
│   ├── agent/
│   │   ├── orchestrator.ts    ← Claude SDK integration, tool loop, multi-agent
│   │   └── prompts.ts         ← System prompt builder
│   │
│   ├── channels/
│   │   ├── webchat/adapter.ts ← WebChat (served via Gateway WebSocket)
│   │   ├── discord/adapter.ts ← Discord (discord.js)
│   │   ├── telegram/adapter.ts← Telegram (grammY)
│   │   └── slack/adapter.ts   ← Slack (Bolt placeholder)
│   │
│   ├── mission-control/
│   │   ├── database.ts        ← 6-table JSON DB (agents, tasks, messages, activities, documents, notifications)
│   │   ├── squad.ts           ← 10-agent squad roster and initialization
│   │   ├── heartbeat.ts       ← Staggered cron heartbeat system
│   │   ├── memory-stack.ts    ← Per-agent WORKING.md / daily notes / MEMORY.md
│   │   └── tools.ts           ← 8 Mission Control tools for Claude tool_use
│   │
│   ├── notifications/
│   │   └── daemon.ts          ← @mention delivery daemon (polls every 2s)
│   │
│   ├── standup/
│   │   └── generator.ts       ← Daily standup report generator
│   │
│   ├── skills/
│   │   └── registry.ts        ← SKILL.md loader and tool registry
│   │
│   ├── memory/
│   │   └── store.ts           ← Persistent keyword-based memory store
│   │
│   ├── scheduler/
│   │   └── scheduler.ts       ← General cron task scheduler
│   │
│   ├── browser/
│   │   └── controller.ts      ← Puppeteer web automation
│   │
│   ├── tools/
│   │   └── executor.ts        ← Built-in tool definitions + executor
│   │
│   ├── config/
│   │   └── index.ts           ← Config loading (.env + JSON merge)
│   │
│   ├── types/
│   │   └── index.ts           ← All TypeScript interfaces
│   │
│   └── utils/
│       └── logger.ts          ← Colored console logger
│
├── agents/                    ← Per-agent SOUL.md personality files
│   ├── jarvis/SOUL.md         ← Squad Lead
│   ├── shuri/SOUL.md          ← Product Analyst
│   ├── fury/SOUL.md           ← Customer Researcher
│   ├── vision/SOUL.md         ← SEO Analyst
│   ├── loki/SOUL.md           ← Content Writer
│   ├── quill/SOUL.md          ← Social Media Manager
│   ├── wanda/SOUL.md          ← Designer
│   ├── pepper/SOUL.md         ← Email Marketing
│   ├── friday/SOUL.md         ← Developer
│   └── wong/SOUL.md           ← Documentation
│
├── skills/                    ← Bundled skills (SKILL.md format)
│   ├── web-search/SKILL.md
│   ├── summarize/SKILL.md
│   └── code-review/SKILL.md
│
├── ui/
│   ├── dashboard/index.html   ← WebChat dashboard (dark theme, chat + status)
│   └── mission-control/index.html ← Mission Control UI (Kanban board, agents, activity)
│
└── tests/
    ├── memory.test.ts         ← Memory store tests (6)
    ├── sessions.test.ts       ← Session manager tests (9)
    ├── skills.test.ts         ← Skill registry tests (5)
    └── mission-control.test.ts← Mission Control tests (15)
```

## Tech Stack

- **Runtime**: Node.js >= 22, TypeScript (ES2022, NodeNext modules)
- **AI**: `@anthropic-ai/sdk` — Claude API with native tool_use
- **HTTP**: Express 4
- **WebSocket**: `ws` library
- **Scheduling**: `croner` for cron jobs
- **CLI**: `commander`
- **Channels**: `discord.js`, `grammy` (Telegram), Slack Bolt (placeholder)
- **Browser**: `puppeteer` (optional, skip download in CI)
- **Testing**: `vitest`
- **Build**: `tsx` for dev, `tsc` for production

## How to Run

```bash
# Install (skip Puppeteer Chrome download if not needed)
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# Run tests (always do this after changes)
npx vitest run

# Start the Gateway (requires ANTHROPIC_API_KEY in .env)
npm run dev

# Or specific commands
npx tsx src/cli/index.ts start
npx tsx src/cli/index.ts doctor
npx tsx src/cli/index.ts status
```

## How to Run Tests

```bash
npx vitest run          # Run all tests once
npx vitest              # Watch mode
npx vitest run tests/mission-control.test.ts  # Single file
```

Currently **35 tests** across 4 test files. All should pass.

## Architecture Overview

### Data Flow

```
User sends message (Discord/Telegram/Slack/WebChat/API)
    ↓
Channel Adapter receives → converts to InboundMessage
    ↓
Gateway.handleInbound() → security check (DM pairing) → broadcast event
    ↓
SessionManager.getOrCreate() → find/create isolated session
    ↓
AgentOrchestrator.processMessage() →
    ├── Build system prompt (SOUL.md + memories + skills)
    ├── Build tools (built-in + Mission Control + skills)
    ├── Claude API call with tool_use loop (max 10 iterations)
    ├── Execute tools: shell, files, memory, MC tasks, MC comments...
    ├── Auto-memorize if user mentions preferences
    └── Return final response text
    ↓
Response sent back through originating channel
```

### Mission Control Flow

```
Heartbeat fires (every 15 min, staggered per agent)
    ↓
HeartbeatSystem.executeHeartbeat() →
    ├── Load WORKING.md (current task state)
    ├── Check undelivered notifications
    ├── Get assigned tasks from MC database
    ├── Get recent activity feed
    ├── Build heartbeat prompt
    └── Call orchestrator.processHeartbeat()
        ↓
    Agent processes, uses MC tools:
        ├── mc_task_create / mc_task_update / mc_task_list
        ├── mc_comment (with @mention → notifications)
        ├── mc_document_create
        ├── mc_activity_feed / mc_agent_list
        └── mc_send_message
        ↓
    If work done → update WORKING.md, append daily notes
    If no work → respond HEARTBEAT_OK
```

### The Gateway is the Central Hub

`src/gateway/server.ts` is THE most important file. It:
1. Creates all subsystems in the constructor
2. Wires them together
3. Sets up HTTP routes (core + Mission Control)
4. Sets up WebSocket for real-time events
5. Initializes the 10-agent squad on start
6. Starts heartbeats, notification daemon, and standup generator

**If you need to add a new subsystem, wire it in Gateway.**

## Key Design Decisions

### Why JSON file DB instead of Convex?
The article uses Convex (cloud database). We use a local JSON file for:
- Zero external dependencies
- Works offline
- Easy to inspect and debug
- Swappable — the `MissionControlDB` class has a clean interface

### Why tool_use loop instead of streaming?
Claude's tool_use with multi-turn is more reliable than streaming for our use case.
The orchestrator runs up to 10 tool iterations per message.

### Why staggered heartbeats?
From the article: "Agents don't all wake at once." Staggering prevents:
- API rate limits
- Resource contention
- Overlapping tool execution

### Session isolation
Each agent has an independent session. Heartbeats create isolated (one-shot) sessions.
This matches OpenClaw's architecture exactly.

## Common Tasks

### Adding a new channel adapter

1. Create `src/channels/<name>/adapter.ts`
2. Implement the `ChannelAdapter` interface (see `src/types/index.ts`)
3. Register in `src/gateway/router.ts` → `registerAdapters()`
4. Add config to `OpenClaudeConfig.channels` in types
5. Add env vars to `.env.example`

### Adding a new skill

1. Create `skills/<name>/SKILL.md`
2. Follow the format (# Name, ## Description, ## Tools, ## Prompt)
3. Optionally add `handler.ts` for custom tool implementations
4. The skill auto-loads on Gateway start

### Adding a new Mission Control tool

1. Add tool definition to `buildMissionControlTools()` in `src/mission-control/tools.ts`
2. Add execution logic to `executeMCTool()` in the same file
3. Tool is automatically available to all agents (prefixed with `mc_`)

### Adding a new agent to the squad

1. Add entry to `SQUAD_ROSTER` array in `src/mission-control/squad.ts`
2. Create `agents/<name>/SOUL.md` with personality
3. The agent auto-registers on Gateway start

### Adding a new API endpoint

1. For core endpoints: add to `setupHTTPRoutes()` in `src/gateway/server.ts`
2. For Mission Control endpoints: add to `setupMissionControlRoutes()`
3. Follow existing patterns (Express route handlers)

## Critical Invariants

1. **All 35 tests must pass** before committing: `npx vitest run`
2. **TypeScript strict mode** is enabled — no `any` types without good reason
3. **Gateway is the single entry point** — all subsystems are wired through it
4. **Sessions are isolated** — never share state between sessions directly
5. **File-based persistence** — everything important is written to disk
6. **ANTHROPIC_API_KEY** is required for the agent to function (not for tests)

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Yes (runtime) | — | Claude API access |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Default model |
| `GATEWAY_HOST` | No | `127.0.0.1` | Gateway bind address |
| `GATEWAY_PORT` | No | `18789` | Gateway port |
| `GATEWAY_SECRET` | No | `change-me` | API auth secret |
| `DM_POLICY` | No | `pairing` | DM security: `pairing` or `open` |
| `SANDBOX_MODE` | No | `true` | Disable shell execution |
| `HEARTBEAT_CRON` | No | `*/15 * * * *` | Default heartbeat interval |
| `MEMORY_DIR` | No | `~/.openclaude/memory` | Memory store path |
| `DISCORD_BOT_TOKEN` | No | — | Discord integration |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram integration |
| `SLACK_BOT_TOKEN` | No | — | Slack integration |

## What's Not Yet Implemented (Future Work)

These are areas identified for future development:

- **Voice support** (macOS/iOS/Android — OpenClaw has this)
- **Canvas/A2UI** (agent-driven visual workspace)
- **Tailscale integration** (remote Gateway access)
- **ClawHub equivalent** (skill marketplace / auto-discovery)
- **Embedding-based memory recall** (currently keyword-based)
- **TypeScript build** (`tsc -b` not yet verified end-to-end)
- **Production auth** (Gateway secret is placeholder)
- **Slack Bolt** full implementation (adapter is a placeholder)
- **Static file serving** for dashboard HTML (currently not wired)
- **WebSocket-based real-time updates** for Mission Control UI (currently polls)
- **Session persistence to disk** (sessions are in-memory only)
- **Agent config files** (loading from `~/.openclaude/agents/*.json`)

## Coding Conventions

- **Modules**: ES modules (`import`/`export`), `.js` extensions in imports
- **Formatting**: 2-space indentation, single quotes, trailing commas
- **Naming**: camelCase for variables/functions, PascalCase for classes/types
- **Comments**: JSDoc-style `/** */` at file and class level; inline comments for non-obvious logic only
- **Error handling**: Try/catch at boundaries, log with `logger.error()`
- **File organization**: One class per file, related files in directories

## Git Branch

Development branch: `claude/recreate-openclaw-project-DnEEc`

Always work on this branch. Push with:
```bash
git push -u origin claude/recreate-openclaw-project-DnEEc
```
