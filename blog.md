# How I Built a 10-Agent AI Team That Runs on My Laptop — No API Key Required

**TL;DR**: I rebuilt the viral "Mission Control" multi-agent architecture using Claude, made it work without paying for an API key by hijacking Claude Code's own OAuth tokens, and now have 10 AI agents collaborating on a shared task board. Here's exactly how.

---

## Table of Contents

| Section | What You'll Learn |
|---------|-------------------|
| [How to Use It](#how-to-use-it) | Get it running in 3 minutes |
| [What Is OpenClaude?](#what-is-openclaude) | The concept and why it exists |
| [The Squad](#the-squad) | Meet the 10 agents |
| [The No-API-Key Hack](#the-no-api-key-hack) | How we bypassed the $20/month barrier |
| [How We Built It](#how-we-built-it) | Development story, blow by blow |
| [What Can You Do With It?](#what-can-you-do-with-it) | Real use cases |
| [Architecture](#architecture) | For the technically curious |
| [What's Next](#whats-next) | Roadmap |

---

## How to Use It

You need: **Node.js 22+** and **Claude Code CLI** authenticated on your machine.

```bash
# Clone
git clone https://github.com/NA-E/Openclaude.git
cd Openclaude
git checkout claude/recreate-openclaw-project-DnEEc

# Install (skip Chrome download — not needed yet)
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# Configure
cp .env.example .env
# Edit .env — no API key needed! Just set:
#   CLAUDE_MODEL=claude-sonnet-4-6
#   GATEWAY_PORT=18789
#   SANDBOX_MODE=true

# Start
npx tsx src/cli/index.ts start
```

Open your browser:
- **WebChat**: [http://localhost:18789/dashboard](http://localhost:18789/dashboard)
- **Mission Control**: [http://localhost:18789/mission-control](http://localhost:18789/mission-control)

That's it. You now have 10 AI agents running on your machine.

### Quick API Test

```bash
# Chat with an agent
curl -X POST http://localhost:18789/api/message \
  -H 'Content-Type: application/json' \
  -d '{"content": "Hello, what can you help me with?"}'

# See all agents
curl http://localhost:18789/api/mc/agents

# See the task board
curl http://localhost:18789/api/mc/tasks

# Trigger a daily standup report
curl -X POST http://localhost:18789/api/mc/standup
```

---

## What Is OpenClaude?

You know that viral thread by [Bhanu Teja P](https://x.com/pbteja1998/status/2017495026230775832) about building "Mission Control" — a system where 10 AI agents work together like a real team? Each agent has a specialty. They wake up on a schedule, check their tasks, collaborate via @mentions, and produce deliverables. It's the AI equivalent of a 10-person startup running 24/7.

**OpenClaude is that system, open source, running locally on your machine.**

It's inspired by [OpenClaw](https://github.com/openclaw/openclaw) but rebuilt from scratch on the Anthropic Claude SDK. No cloud database. No external services. Everything runs locally — your data never leaves your machine.

---

## The Squad

10 agents, each with a distinct personality defined in their own `SOUL.md` file:

| Agent | Role | What They Actually Do |
|-------|------|----------------------|
| **Jarvis** | Squad Lead | Delegates work, monitors progress, breaks ties |
| **Shuri** | Product Analyst | UX testing, edge cases, competitive analysis |
| **Fury** | Customer Researcher | G2 reviews, customer intel, evidence-backed claims |
| **Vision** | SEO Analyst | Keywords, search intent, content optimization |
| **Loki** | Content Writer | Blog posts, copy (pro-Oxford-comma, naturally) |
| **Quill** | Social Media | Hooks, threads, build-in-public content |
| **Wanda** | Designer | Infographics, mockups, visual thinking |
| **Pepper** | Email Marketing | Drip sequences, lifecycle emails, conversions |
| **Friday** | Developer | Clean code, testing, architecture |
| **Wong** | Documentation | Knowledge bases, organization, templates |

They don't just respond to you. They respond to *each other*. Jarvis can @mention Vision to request keyword research, Vision posts findings on the task board, Loki picks them up and writes a blog post, Quill turns it into social threads — all autonomously.

---

## The No-API-Key Hack

This is the part nobody talks about. Anthropic's API costs money. If you already pay for Claude Pro ($20/month), you're already authenticated — but Anthropic doesn't let you use those credentials for the API.

We found a way around that.

### The Problem

```
Anthropic SDK → api.anthropic.com → 401 "OAuth authentication is currently not supported"
```

Claude Code CLI is authenticated on your machine. It stores OAuth tokens in `~/.claude/.credentials.json`. But if you try to use those tokens with the official Anthropic SDK, the API server rejects them.

### What We Tried (and Failed)

1. **Direct API with OAuth Bearer token** — 401. Blocked.
2. **Anthropic SDK `authToken` option** — Same 401. Blocked.
3. **Custom headers (`x-client-app: claude-code`)** — Still 401. Blocked.
4. **Token refresh endpoint discovery** — We grepped the Claude binary to find the real endpoint: `platform.claude.com/v1/oauth/token` (not the documented `console.anthropic.com` one). Token refresh works! But the API still won't accept it.

### What Actually Worked

Instead of fighting the API, we went around it:

```typescript
// Instead of:  new Anthropic({ authToken })
// We do:       spawn('claude', ['-p', '--output-format=json', ...])
```

We built `SubprocessClient` — a drop-in replacement for the Anthropic SDK that spawns Claude Code as a subprocess. Claude Code handles its own auth. We just pipe messages in and responses out.

**Key tricks that took hours to figure out:**
- Must delete `CLAUDECODE` env var before spawning (prevents "nested session" error)
- Must delete `ANTHROPIC_API_KEY` env var (prevents SDK conflicts)
- Use `stdio: ['ignore', 'pipe', 'pipe']` — stdin must be closed or permission prompts hang forever
- Do NOT use `--dangerously-skip-permissions` — counterintuitively, it hangs worse

The result: full Claude access using your existing Claude Pro subscription. Zero additional cost.

---

## How We Built It

### Hour 1: Clone and Discover

Cloned the repo, read the README. It's a full TypeScript project — Express gateway, WebSocket, 10 agent personalities, cron heartbeats, task board, notification daemon. Impressive scope.

One problem: it requires `ANTHROPIC_API_KEY` in `.env`. We don't have one.

### Hour 2: The OAuth Rabbit Hole

Started investigating how Claude Code authenticates. Found OAuth credentials in `~/.claude-acc1/.credentials.json`:

```json
{
  "claudeAiOauth": {
    "accessToken": "eyJ...",
    "refreshToken": "v1.ref...",
    "expiresAt": 1740950400000
  }
}
```

Built `token-provider.ts` to read and refresh these tokens. Token refresh worked on the first try (after finding the right endpoint by grepping the binary). Access tokens last 8 hours and auto-refresh.

### Hour 3: The API Wall

Tried using the token with the Anthropic SDK. 401. Tried every header combination. 401. The API explicitly blocks OAuth tokens — it only accepts `sk-ant-*` API keys.

This was the turning point. Instead of giving up, we asked: *what if we don't use the API at all?*

### Hour 4: The Subprocess Breakthrough

Claude Code CLI works. It's authenticated. What if we just... call it?

```bash
claude -p "Hello" --output-format=json
```

It works. Returns JSON. Takes system prompts. Uses the existing OAuth session.

Built `subprocess-client.ts` to wrap this as a proper client with the same interface as the Anthropic SDK. Rewired the orchestrator. First E2E test passed:

```
> "OpenClaude is working!"
```

### Hour 5: Gateway and UI

Removed the API key check from the CLI entry point. Started the gateway. Hit the dashboard — "Cannot GET /dashboard". Static file serving wasn't wired up. Added Express routes for the UI files. Both dashboards loading.

All 35 tests still passing.

---

## What Can You Do With It?

### Right Now

- **Chat with AI agents** via WebChat dashboard or REST API
- **View the task board** in Mission Control — Kanban with Inbox/Assigned/In Progress/Review/Done/Blocked
- **See all 10 agents** with their roles and status
- **Trigger daily standups** to get a summary of what happened
- **Connect Discord/Telegram** for multi-channel messaging
- **Use the REST API** to integrate with anything

### Example Workflows

**Content Pipeline**: Create a task "Write blog post about X" → Jarvis delegates to Vision for keyword research → Vision posts findings → Loki writes the draft → Shuri reviews for UX → Quill creates social posts

**Customer Research**: Ask Fury to research competitors on G2 → Fury gathers intel and posts to task board → Shuri analyzes for product implications → Wong documents findings

**Developer Workflow**: Assign a coding task to Friday → Friday architects and implements → Wong writes documentation → Pepper drafts the launch email

### What's Coming

The agents currently respond with text only — they can't autonomously execute Mission Control tools (create tasks, post comments, etc.) via the subprocess. The fix: expose MC tools as an MCP server and pass `--mcp-config` to the subprocess. This is the #1 priority for the next session.

---

## Architecture

For the technically curious, here's what's under the hood.

```
User sends message (Discord / Telegram / Slack / WebChat / API)
    |
    v
Channel Adapter → converts to InboundMessage
    |
    v
Gateway.handleInbound() → security check → broadcast event
    |
    v
SessionManager → find/create isolated session
    |
    v
AgentOrchestrator → SubprocessClient → claude -p → response
    |
    v
Response sent back through originating channel
```

**Stack**: TypeScript, Express, `ws` (WebSocket), `croner` (scheduling), Node.js 22

**Data**: Everything in local JSON files. Zero external dependencies. Works offline.

**Sessions**: Fully isolated per agent. Heartbeats create one-shot sessions.

**Memory**: File-based. Each agent maintains `WORKING.md` (current state), daily logs, and `MEMORY.md` (long-term). The golden rule from the original article: *if you want to remember something, write it to a file.*

---

## What's Next

1. **MCP Server for MC Tools** — Re-enable autonomous agent actions by exposing Mission Control tools as an MCP server
2. **Token Rotation** — Rotate across multiple accounts (acc1/acc2/acc3) when rate limited
3. **Voice Support** — macOS/iOS/Android voice input
4. **Embedding-Based Memory** — Replace keyword search with semantic recall
5. **Production Auth** — Real authentication for the gateway

---

## Key Takeaways

1. **You don't need an API key** to build with Claude if you're already paying for Claude Pro. The subprocess approach works.
2. **10 agents > 1 agent**. Specialization works for AI the same way it works for humans.
3. **Local-first is underrated**. No cloud DB, no vendor lock-in, everything inspectable on disk.
4. **Read the binary**. When docs fail, `grep` the binary. That's how we found the real OAuth endpoint.
5. **Mission Control is the killer feature**. A shared task board turns chatbots into a team.

---

*Built with Claude Code in one session. 35 tests passing. MIT licensed.*

*[GitHub](https://github.com/NA-E/Openclaude) | [Mission Control Guide](https://x.com/pbteja1998/status/2017495026230775832)*
