# Development Guide

How to set up, run, test, and extend OpenClaude.

## Prerequisites

- Node.js >= 22
- npm
- An Anthropic API key (for runtime, not needed for tests)

## Setup

```bash
# Clone and install
git clone <repo-url>
cd Openclaude

# Install dependencies (skip Puppeteer Chrome download in CI/sandbox)
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# Copy environment template
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

## Running

### Development Mode (with tsx)

```bash
# Start the Gateway (main entry point)
npm run dev

# Or with specific options
npx tsx src/cli/index.ts start --port 18789

# Other CLI commands
npx tsx src/cli/index.ts doctor       # Check configuration
npx tsx src/cli/index.ts status       # Show runtime status
npx tsx src/cli/index.ts message "Hi" # Send a message
npx tsx src/cli/index.ts agent list   # List agents
npx tsx src/cli/index.ts skill list   # List skills
npx tsx src/cli/index.ts task list    # List scheduled tasks
```

### Docker

```bash
docker-compose up -d
# Or
docker build -t openclaude .
docker run -p 18789:18789 --env-file .env openclaude
```

## Testing

```bash
# Run all tests (35 tests across 4 files)
npx vitest run

# Watch mode
npx vitest

# Single test file
npx vitest run tests/mission-control.test.ts

# With coverage
npx vitest run --coverage
```

### Test Structure

| File | Tests | What It Covers |
|------|:-----:|----------------|
| `tests/memory.test.ts` | 6 | Memory store: remember, recall, forget, category/tag/agent filtering |
| `tests/sessions.test.ts` | 9 | Sessions: create, reuse, per-channel isolation, groups, pairing codes, agent-to-agent |
| `tests/skills.test.ts` | 5 | Skill loading from workspace, programmatic registration, agent filtering |
| `tests/mission-control.test.ts` | 15 | MC database CRUD, squad init, notifications, memory stack, standup generation |

### Writing Tests

Tests use vitest with temp directories for isolation:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MyFeature', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should do something', () => {
    // Test code using tempDir for file-based state
  });
});
```

## Adding New Features

### New Channel Adapter

1. Create adapter file:
```bash
mkdir -p src/channels/signal
```

2. Implement the interface:
```typescript
// src/channels/signal/adapter.ts
import type { ChannelAdapter, InboundMessage, OutboundMessage, Channel } from '../../types/index.js';

export class SignalAdapter implements ChannelAdapter {
  type = 'signal' as const;
  // ... implement connect, disconnect, send, onMessage, getStatus
}
```

3. Register in router (`src/gateway/router.ts`):
```typescript
if (this.config.channels.signal) {
  this.adapters.set('signal', new SignalAdapter(this.config.channels.signal));
}
```

4. Add to types (`src/types/index.ts`):
```typescript
export type ChannelType = 'webchat' | 'discord' | 'telegram' | 'slack' | 'signal' | 'api';
```

5. Add config + env vars.

### New Squad Member

1. Add to `SQUAD_ROSTER` in `src/mission-control/squad.ts`:
```typescript
{
  name: 'Groot',
  role: 'Data Analyst',
  sessionKey: 'agent:data-analyst:main',
  level: 'specialist',
  avatar: 'G',
  skills: ['data-analysis', 'visualization'],
  heartbeatCron: '3,18,33,48 * * * *',  // Stagger!
  personality: 'Data-driven. Speaks in charts and numbers.',
}
```

2. Create SOUL file:
```bash
mkdir -p agents/groot
# Write agents/groot/SOUL.md
```

### New Skill

Create `skills/my-skill/SKILL.md`:
```markdown
# My Skill

## Description
What this skill does.

- **Version**: 1.0.0

## Tools
- `my_tool`: Description

## Prompt
Context injected into the system prompt when this skill is active.
```

For skills with custom tool execution, add `handler.ts` in the same directory.

### New Mission Control Tool

In `src/mission-control/tools.ts`:

1. Add to `buildMissionControlTools()`:
```typescript
{
  name: 'mc_my_tool',
  description: 'What this tool does',
  input_schema: { type: 'object', properties: { ... }, required: [...] },
}
```

2. Add to `executeMCTool()` switch:
```typescript
case 'mc_my_tool': {
  // Implementation
  return 'Result';
}
```

### New API Endpoint

In `src/gateway/server.ts`, add to `setupMissionControlRoutes()` or `setupHTTPRoutes()`:
```typescript
this.app.get('/api/my-endpoint', (req, res) => {
  res.json({ data: 'result' });
});
```

## Project Conventions

- **ES modules** with `.js` extensions in imports (TypeScript compiles to ESM)
- **Strict TypeScript** — no implicit `any`
- **File-per-class** — one main export per source file
- **Tests alongside features** — add tests in `tests/` for new functionality
- **Logger** — use `logger.info('Component', 'message')` not `console.log`
- **Error handling** — try/catch at boundaries, never swallow errors silently

## Debugging

### Check Gateway health
```bash
curl http://localhost:18789/health
```

### Check Mission Control state
```bash
curl http://localhost:18789/api/mc/stats
curl http://localhost:18789/api/mc/agents
curl http://localhost:18789/api/mc/tasks
curl http://localhost:18789/api/mc/activities?limit=10
```

### Trigger a manual standup
```bash
curl -X POST http://localhost:18789/api/mc/standup
```

### Send a test message
```bash
curl -X POST http://localhost:18789/api/message \
  -H 'Content-Type: application/json' \
  -d '{"content": "Hello Claude!"}'
```

### Inspect Mission Control database
```bash
cat ~/.openclaude/mission-control/mission-control.json | jq .
```

### Check agent memory files
```bash
ls ~/.openclaude/workspace/memory/
cat ~/.openclaude/workspace/memory/agent-main-main/WORKING.md
```
