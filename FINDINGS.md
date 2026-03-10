# FINDINGS.md — Research Notes & Improvement Recommendations

Strategic notes from studying OpenClaw, intelligent agent architecture, and the Bangladesh digital product funnel.

---

## 1. OpenClaw Study — What We Learned

### What OpenClaw Does Better

| Gap | OpenClaw | OpenClaude (current) | Priority |
|-----|----------|----------------------|----------|
| Memory | Embedding-based semantic recall | Keyword JSON store | HIGH |
| Streaming | Real-time tool result streaming | Batch response | MEDIUM |
| Canvas/A2UI | Agent-driven visual workspace | None | LOW |
| ClawHub | Skill marketplace (auto-discovery) | Manual SKILL.md files | MEDIUM |
| Voice | macOS/iOS/Android voice integration | None | LOW |
| Session persistence | Persists to disk | In-memory only | HIGH |

### Key Takeaway
Embedding-based memory is the single highest-leverage improvement. Without it, agents can't learn from past interactions in a meaningful way. Every other "intelligence" feature depends on good recall.

---

## 2. What Makes an Intelligent Agent — Engineering Breakdown

### Core Components

```
1. PERCEPTION
   - Multi-modal input (text, voice, image, file)
   - Context window management (what to include, what to compress)
   - Memory retrieval (what past knowledge is relevant now?)

2. REASONING
   - LLM backbone (Claude, GPT, etc.)
   - Chain-of-thought / scratchpad
   - Tool selection (which tool fits the task?)
   - Multi-step planning (break goal → sub-tasks)

3. ACTION
   - Tool execution (shell, browser, API, file system)
   - Multi-agent delegation (spawn sub-agents for parallel work)
   - Output formatting (adapt to channel/audience)

4. LEARNING
   - Short-term: conversation context (current session)
   - Medium-term: working memory (WORKING.md, daily notes)
   - Long-term: consolidated memory (MEMORY.md, embeddings)
   - Meta-learning: agent scores its own responses, updates strategy

5. SELF-HEALING
   - Watchdog daemon: monitors subprocess health, auto-restarts
   - Tool failure tracker: disables flaky tools, alerts user
   - Retry with different approach on failure (not same approach)
   - Error pattern recognition: learns what breaks, avoids it

6. SELF-EXPANDING
   - Skill writer: I can write new SKILL.md files autonomously
   - Agent spawner: create new specialized agents for new domains
   - Auto-discovery: scan skill registries for new capabilities
   - Capability gap detection: notice when I can't do something, request new tool
```

### Building Blocks (Concrete Code Targets)

```
Phase 1 — Self-Learning (memory upgrade)
├── Replace src/memory/store.ts → add transformers.js embeddings
├── Nightly reflection: agent rates its own responses (1-5)
├── Weekly consolidation: compress daily notes → MEMORY.md
└── Semantic search: "what did user say about X?" → vector similarity

Phase 2 — Self-Healing (resilience)
├── Add watchdog to src/notifications/daemon.ts (monitors all subprocesses)
├── Tool failure log in mission-control.json
├── Retry logic: different tool/approach, not same failed call
└── Health endpoint: GET /health returns all subsystem status

Phase 3 — Self-Expanding (autonomy)
├── src/tools/skill-writer.ts — generate new SKILL.md from natural language
├── Sub-agent spawner — create new SOUL.md + register in squad
├── Capability gap tracker — log "I couldn't do X, need tool Y"
└── MCP tool auto-discovery — scan for new MCP servers to attach
```

---

## 3. Bangladesh Digital Bundle — Strategy Notes

### Math Clarity
- **250 BDT × 100,000 customers = 2.5 crore (25M BDT)**
- To reach 250M BDT: need 1M customers OR ~2,500 BDT pricing
- Recommendation: 250 BDT entry is right for volume. Add upsells.

### Funnel Architecture
```
STAGE 1 — Awareness (Free)
├── Facebook Group: give away 1-2 worksheets free
├── Email list warm-up: weekly value drops
└── Goal: build trust + collect leads

STAGE 2 — Conversion (250 BDT bundle)
├── Landing page with bundle showcase
├── Payment: bKash / Nagad / card
└── Goal: convert 5-10% of warm list

STAGE 3 — Upsell
├── Live workshop (500-1000 BDT)
├── Coaching / community access
└── Goal: 2x revenue from existing buyers
```

### Biggest Barrier: Worksheet Visual Showcase
The #1 problem identified: **generating high-quality images that show the worksheets in use**.

**Why it matters:** Bangladeshi buyers buy on visual proof. They need to see the worksheet, feel the quality, imagine using it.

**Solutions (ranked by feasibility):**

| Approach | Tool | Cost | Quality |
|----------|------|------|---------|
| Mockup templates | Canva / Placeit | Low | Medium |
| AI image generation | Midjourney / Ideogram | Low | High |
| Actual photography | Phone camera + good light | Zero | Very High |
| Figma mockup frames | Figma (free tier) | Zero | High |
| PDF-to-image export | Adobe / online tools | Low | Medium |

**Recommended approach:**
1. Export worksheet pages as high-res PNG (from whatever software made them)
2. Place into Figma device/desk mockup frames (free templates exist)
3. Use Midjourney/Ideogram to generate lifestyle context (someone using the worksheet at a desk)
4. Combine: mockup in context = professional showcase

**Wanda (designer agent) can handle this** — once we have the worksheet files, Wanda can generate Figma mockup specs and Midjourney prompts for each worksheet.

---

## 4. Agent Assignment for These Goals

| Goal | Agent | Status |
|------|-------|--------|
| Worksheet image generation | Wanda | Needs worksheet files |
| Landing page copy + structure | Loki + Shuri | Ready |
| Facebook group content plan | Quill | Ready |
| Email warm-up sequence | Pepper | Ready |
| SEO for landing page | Vision | Ready |
| Bundle pricing research | Fury (customer researcher) | Ready |
| Embedding memory upgrade | Friday (developer) | Phase 1 target |

---

*Last updated: 2026-03-10*
