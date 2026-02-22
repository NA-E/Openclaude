# OpenClaude

**Your own personal AI assistant powered by Claude. Any OS. Any Platform. The Claude way.**

OpenClaude is an open-source personal AI assistant inspired by [OpenClaw](https://github.com/openclaw/openclaw), rebuilt from the ground up using the Anthropic Claude SDK. It implements the full **Mission Control** architecture from [@pbteja1998's viral guide](https://x.com/pbteja1998/status/2017495026230775832) — a system where 10 AI agents work together like a real team.

## What It Does

A squad of 10 AI agents, each with their own personality and specialty, working together on a shared task board. They wake up every 15 minutes, check for work, post comments, create deliverables, and coordinate — all autonomously.

```
Jarvis (Lead) delegates → Vision researches keywords → Fury gathers intel
  → Loki writes content → Shuri reviews for UX → Quill creates social posts
    → All tracked in Mission Control with full audit trail
```

## Features

### Core Platform
- **Multi-Channel Messaging** — WebChat, Discord, Telegram, Slack, or REST API
- **Claude-Powered Brain** — Claude Opus 4.6 via Anthropic SDK with native tool use
- **Persistent Memory** — Local-first file-based storage that survives restarts
- **Skills System** — Markdown-defined plugins (`SKILL.md` format)
- **Browser Automation** — Puppeteer-based web navigation and data extraction
- **Privacy-First** — Runs locally, your data stays on your machine

### Mission Control (Multi-Agent System)
- **10-Agent Squad** — Jarvis, Shuri, Fury, Vision, Loki, Quill, Wanda, Pepper, Friday, Wong
- **Shared Task Board** — Kanban with 6 states: Inbox → Assigned → In Progress → Review → Done / Blocked
- **Heartbeat System** — Staggered cron wakeups every 15 minutes per agent
- **@Mention Notifications** — `@Vision` notifies Vision; `@all` notifies everyone
- **Thread Subscriptions** — Comment on a task → auto-subscribed to all future updates
- **Daily Standup** — Automated summary: completed/in-progress/blocked/needs-review
- **Memory Stack** — Per-agent WORKING.md, daily notes, and long-term memory
- **8 MC Tools** — Agents can create tasks, post comments, write documents, message each other
- **Activity Feed** — Real-time audit trail of everything happening
- **Document Storage** — Deliverables, research, protocols stored per-task

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       Gateway Server                               │
│              ws://127.0.0.1:18789 (WS + HTTP)                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Channels          Agent Orchestrator        Mission Control       │
│  ┌─────────┐      ┌────────────────┐       ┌────────────────┐    │
│  │ Discord │      │ Claude SDK     │       │ Task Database  │    │
│  │ Telegram│ ───→ │ Tool Use Loop  │ ←───→ │ 10-Agent Squad │    │
│  │ Slack   │      │ System Prompts │       │ Heartbeats     │    │
│  │ WebChat │      └────────────────┘       │ Notifications  │    │
│  │ API     │              │                │ Daily Standup  │    │
│  └─────────┘      ┌──────┴──────┐         └────────────────┘    │
│                    │             │                                  │
│               ┌────┴───┐  ┌─────┴────┐  ┌──────────────────┐     │
│               │ Memory │  │  Skills  │  │ Agent Memory     │     │
│               │ Store  │  │ Registry │  │ Stack (per-agent) │     │
│               └────────┘  └──────────┘  └──────────────────┘     │
└────────────────────────────────────────────────────────────────────┘
```

## The Squad

| Agent | Role | Specialty |
|-------|------|-----------|
| **Jarvis** | Squad Lead | Coordination, delegation, progress monitoring |
| **Shuri** | Product Analyst | UX testing, edge cases, competitive analysis |
| **Fury** | Customer Researcher | G2 reviews, customer intel, evidence-backed claims |
| **Vision** | SEO Analyst | Keywords, search intent, content optimization |
| **Loki** | Content Writer | Blog posts, copy, pro-Oxford-comma |
| **Quill** | Social Media | Hooks, threads, build-in-public content |
| **Wanda** | Designer | Infographics, mockups, visual thinking |
| **Pepper** | Email Marketing | Drip sequences, lifecycle emails, conversions |
| **Friday** | Developer | Clean code, testing, architecture |
| **Wong** | Documentation | Knowledge bases, organization, templates |

Each agent has a unique `SOUL.md` personality file in `agents/<name>/`.

## Quick Start

```bash
# 1. Install
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# 2. Configure
cp .env.example .env
# Edit .env: add ANTHROPIC_API_KEY=sk-ant-...

# 3. Start
npm run dev
```

The Gateway starts on `http://127.0.0.1:18789`:
- **WebChat Dashboard**: `/dashboard`
- **Mission Control**: `/mission-control`
- **REST API**: `/api/*`
- **WebSocket**: `ws://127.0.0.1:18789`

## CLI

```bash
openclaude start              # Start Gateway + all subsystems
openclaude doctor             # Diagnose configuration
openclaude status             # Show runtime status
openclaude message "hello"    # Send a message via CLI
openclaude agent list         # List the squad
openclaude skill list         # List installed skills
openclaude task list          # List scheduled tasks
```

## Mission Control API

```bash
# Squad status
curl http://localhost:18789/api/mc/stats
curl http://localhost:18789/api/mc/agents

# Task management
curl http://localhost:18789/api/mc/tasks
curl -X POST http://localhost:18789/api/mc/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Research competitors","description":"...","status":"inbox","priority":"high","assigneeIds":[],"creatorId":"user","tags":["research"]}'

# Task comments
curl http://localhost:18789/api/mc/tasks/{id}/messages

# Activity feed
curl http://localhost:18789/api/mc/activities?limit=20

# Documents
curl http://localhost:18789/api/mc/documents

# Trigger daily standup
curl -X POST http://localhost:18789/api/mc/standup

# Heartbeat schedule
curl http://localhost:18789/api/mc/heartbeat
```

## Core API

```bash
# Send a message to the default agent
curl -X POST http://localhost:18789/api/message \
  -H 'Content-Type: application/json' \
  -d '{"content": "Hello Claude!"}'

# System status
curl http://localhost:18789/api/status

# Sessions, agents, skills, channels
curl http://localhost:18789/api/sessions
curl http://localhost:18789/api/agents
curl http://localhost:18789/api/skills
curl http://localhost:18789/api/channels
```

## Skills

Bundled: **web-search**, **summarize**, **code-review**

Add your own in `skills/<name>/SKILL.md`:
```markdown
# My Skill

## Description
What this skill does.

## Prompt
Context injected into the agent's system prompt.
```

## Memory

The article's "Golden Rule": **If you want to remember something, write it to a file.**

Each agent has:
- `WORKING.md` — Current task state (read first on every wakeup)
- `YYYY-MM-DD.md` — Daily logs
- `MEMORY.md` — Curated long-term memory

## Heartbeat Protocol

Every 15 minutes, each agent wakes up and:
1. Reads WORKING.md for current task state
2. Checks @mentions and notifications
3. Scans assigned tasks
4. Reviews activity feed
5. Takes action or reports `HEARTBEAT_OK`

Schedules are staggered so agents don't all wake at once:
```
:00 Pepper  :04 Friday  :08 Vision  :12 Quill  :14 Jarvis
:02 Shuri   :06 Loki    :10 Fury    :13 Wong
                         :07 Wanda
```

## Docker

```bash
docker-compose up -d
```

## Security

- **DM Pairing**: Unknown senders get a 6-char code (`DM_POLICY=pairing`)
- **Sandbox Mode**: Disables shell execution (`SANDBOX_MODE=true`)
- **Per-channel allowlists**: Discord/Telegram user ID filtering
- Run `openclaude doctor` to audit your configuration

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — Guide for Claude Code sessions (start here if you're an AI)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Detailed system architecture
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — How to run, test, and extend
- [`AGENTS.md`](AGENTS.md) — Operating manual injected into all agents
- [`SOUL.md`](SOUL.md) — Default agent personality
- [`TOOLS.md`](TOOLS.md) — Tool usage guidelines

## Comparison with OpenClaw

| Feature | OpenClaw | OpenClaude |
|---------|----------|------------|
| AI Model | Any (recommends Claude) | Claude (Anthropic SDK) |
| Channels | 15+ | 5 (WebChat, Discord, Telegram, Slack, API) |
| Multi-Agent | Session-based | 10-agent squad with Mission Control |
| Task Board | Convex database | Local JSON file DB (same schema) |
| Skills | ClawHub registry | Local SKILL.md files |
| Memory | Markdown files | WORKING.md + daily notes + MEMORY.md |
| Heartbeats | Cron + staggered | Cron + staggered (identical pattern) |
| Notifications | @mentions + threads | @mentions + thread subscriptions |
| Daily Standup | Cron summary | Automated standup generator |
| Browser | Chrome CDP | Puppeteer |
| Dashboard | Custom React UI | Kanban + activity feed + agent cards |
| Voice | macOS/iOS/Android | Not yet |
| Canvas | A2UI | Not yet |

## Inspired By

- [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger
- [Mission Control guide](https://x.com/pbteja1998/status/2017495026230775832) by Bhanu Teja P
- The idea that AI agents should work like a team, not a search box

## License

MIT
