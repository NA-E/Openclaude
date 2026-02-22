# OpenClaude

**Your own personal AI assistant powered by Claude. Any OS. Any Platform. The Claude way.**

OpenClaude is an open-source personal AI assistant inspired by [OpenClaw](https://github.com/openclaw/openclaw), rebuilt from the ground up using the Anthropic Claude SDK. It runs locally on your machine, communicates across multiple messaging platforms, and becomes uniquely yours over time through persistent memory.

## Features

- **Multi-Channel Messaging** — Chat with your AI via WebChat, Discord, Telegram, Slack, or the REST API. All channels route through a single Gateway.
- **Claude-Powered Brain** — Uses Claude Opus 4.6 via the Anthropic SDK with native tool use for shell commands, file operations, web browsing, and more.
- **Persistent Memory** — Remembers facts, preferences, and context across conversations. Local-first file-based storage.
- **Skills System** — Extend capabilities with markdown-defined skills. Drop a `SKILL.md` into `skills/` and the agent learns new abilities.
- **Task Scheduler** — Cron-based autonomous task execution. The agent wakes up on a heartbeat and proactively handles scheduled work.
- **Multi-Agent Coordination** — Register multiple specialized agents (researcher, coder, writer) that communicate with each other via isolated sessions.
- **Browser Automation** — Navigate websites, extract data, fill forms, take screenshots via Puppeteer.
- **Privacy-First** — Runs locally. Your data stays on your machine. MIT licensed.
- **WebSocket Control Plane** — Real-time Gateway events for building dashboards and integrations.
- **Personality System** — Customize your assistant's personality via `SOUL.md`.

## Architecture

```
                        ┌─────────────────┐
                        │   Dashboard UI  │
                        │   (WebChat)     │
                        └────────┬────────┘
                                 │ WebSocket
┌──────────┐  ┌──────────┐  ┌───┴───────────────┐  ┌──────────┐
│ Discord  │──│ Telegram │──│     Gateway       │──│  Slack   │
│ Adapter  │  │ Adapter  │  │  (WS + HTTP)      │  │ Adapter  │
└──────────┘  └──────────┘  └───┬───────────────┘  └──────────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
              ┌─────┴─────┐ ┌──┴──┐ ┌──────┴──────┐
              │  Session   │ │Agent│ │  Scheduler  │
              │  Manager   │ │Orch.│ │  (Cron)     │
              └────────────┘ └──┬──┘ └─────────────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
              ┌─────┴─────┐ ┌──┴──────┐ ┌──┴───────┐
              │  Memory   │ │  Skills │ │ Browser  │
              │  Store    │ │ Registry│ │ Control  │
              └───────────┘ └─────────┘ └──────────┘
```

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-user/openclaude.git
cd openclaude

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# 4. Start
npm run dev

# Or use the CLI
npx tsx src/cli/index.ts start
```

The Gateway starts on `http://127.0.0.1:18789` with:
- HTTP REST API for management
- WebSocket for real-time events
- WebChat dashboard at the root URL

## CLI Commands

```bash
openclaude start              # Start Gateway and all services
openclaude setup              # Interactive setup wizard
openclaude doctor             # Diagnose configuration issues
openclaude status             # Show system status
openclaude message "hello"    # Send a message via CLI
openclaude agent list         # List registered agents
openclaude skill list         # List installed skills
openclaude task list          # List scheduled tasks
```

## Channels

| Channel   | Status | Config Required              |
|-----------|--------|------------------------------|
| WebChat   | Ready  | None (always available)      |
| Discord   | Ready  | `DISCORD_BOT_TOKEN`          |
| Telegram  | Ready  | `TELEGRAM_BOT_TOKEN`         |
| Slack     | Ready  | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| REST API  | Ready  | None                         |

## Skills

Skills are markdown-defined plugins in `skills/<name>/SKILL.md`:

```markdown
# My Skill

## Description
What this skill does.

## Tools
- `my_tool`: Description of the tool

## Prompt
Additional context injected into the agent's system prompt.
```

### Bundled Skills

- **web-search** — Search the web for information
- **summarize** — Summarize long texts and documents
- **code-review** — Review code for bugs, security issues, and best practices

## Multi-Agent Setup

Create agents in `~/.openclaude/agents/`:

```json
{
  "id": "researcher",
  "name": "Research Agent",
  "model": "claude-opus-4-6",
  "systemPrompt": "You are a research specialist...",
  "skills": ["web-search", "summarize"],
  "memoryEnabled": true
}
```

Agents communicate via the `sessions_send` tool, enabling mission-control style coordination (inspired by [@pbteja1998's 10-agent squad](https://x.com/pbteja1998/status/2017495026230775832)).

## REST API

```bash
# Send a message
curl -X POST http://localhost:18789/api/message \
  -H 'Content-Type: application/json' \
  -d '{"content": "Hello Claude!"}'

# Get system status
curl http://localhost:18789/api/status

# List sessions
curl http://localhost:18789/api/sessions

# List agents
curl http://localhost:18789/api/agents

# List skills
curl http://localhost:18789/api/skills

# Schedule a task
curl -X POST http://localhost:18789/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "default",
    "name": "Daily Summary",
    "cron": "0 9 * * *",
    "prompt": "Summarize my pending tasks and any important updates",
    "enabled": true
  }'
```

## Docker

```bash
# Build and run
docker-compose up -d

# Or standalone
docker build -t openclaude .
docker run -p 18789:18789 --env-file .env openclaude
```

## Security

- **DM Policy**: Set `DM_POLICY=pairing` (default) to require pairing codes for unknown senders
- **Sandbox Mode**: Set `SANDBOX_MODE=true` (default) to disable shell command execution
- **Allowlists**: Configure per-channel user allowlists
- Run `openclaude doctor` to diagnose security configuration

## Configuration

Configuration is loaded from environment variables and `~/.openclaude/openclaude.json`.

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-opus-4-6` | Default model |
| `GATEWAY_PORT` | `18789` | Gateway port |
| `DM_POLICY` | `pairing` | DM security policy |
| `SANDBOX_MODE` | `true` | Enable sandbox mode |
| `HEARTBEAT_CRON` | `*/15 * * * *` | Heartbeat schedule |
| `MEMORY_DIR` | `~/.openclaude/memory` | Memory storage path |

## Personality

Customize your assistant by editing `SOUL.md` in the project root. This file defines the personality traits, communication style, and boundaries of your assistant.

## Comparison with OpenClaw

| Feature | OpenClaw | OpenClaude |
|---------|----------|------------|
| AI Model | Any (recommends Claude) | Claude (Anthropic SDK) |
| Channels | 15+ | 5 (WebChat, Discord, Telegram, Slack, API) |
| Skills | ClawHub registry | Local SKILL.md files |
| Memory | Markdown files | JSON file store |
| Browser | Chrome CDP | Puppeteer |
| Voice | macOS/iOS/Android | Not yet |
| Scheduler | Cron + webhooks | Cron |
| Multi-Agent | Full routing | Agent-to-agent messaging |
| Canvas | A2UI | Not yet |
| Setup | CLI wizard | CLI + env vars |

## License

MIT
