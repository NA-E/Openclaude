/**
 * The Squad — 10 named AI agents, each with a role and personality.
 *
 * From the article:
 * "Ten agents equals ten sessions. Each waking up on their own schedule.
 *  Each with their own context."
 *
 * Agent levels:
 * - Intern: Needs approval for most actions
 * - Specialist: Works independently in their domain
 * - Lead: Full autonomy, can make decisions and delegate
 */

import type { MissionControlDB, MCAgent } from './database.js';
import { logger } from '../utils/logger.js';

export interface SquadMember {
  name: string;
  role: string;
  sessionKey: string;
  level: 'intern' | 'specialist' | 'lead';
  avatar: string;
  skills: string[];
  heartbeatCron: string;  // Staggered so agents don't all wake at once
  personality: string;    // Short personality descriptor
}

/**
 * The 10-agent squad, directly from the article.
 * Heartbeats are staggered:
 *   :00 Pepper, :02 Shuri, :04 Friday, :06 Loki,
 *   :07 Wanda, :08 Vision, :10 Fury, :12 Quill
 *   :13 Wong, :14 Jarvis (lead checks last)
 */
export const SQUAD_ROSTER: SquadMember[] = [
  {
    name: 'Jarvis',
    role: 'Squad Lead',
    sessionKey: 'agent:main:main',
    level: 'lead',
    avatar: 'J',
    skills: ['coordination', 'delegation', 'monitoring', 'all-tools'],
    heartbeatCron: '14,29,44,59 * * * *',
    personality: 'The coordinator. Handles direct requests, delegates, monitors progress. Primary interface with the user.',
  },
  {
    name: 'Shuri',
    role: 'Product Analyst',
    sessionKey: 'agent:product-analyst:main',
    level: 'specialist',
    avatar: 'S',
    skills: ['testing', 'ux-analysis', 'competitive-analysis', 'bug-hunting'],
    heartbeatCron: '2,17,32,47 * * * *',
    personality: 'Skeptical tester. Thorough bug hunter. Finds edge cases. Thinks like a first-time user. Questions everything.',
  },
  {
    name: 'Fury',
    role: 'Customer Researcher',
    sessionKey: 'agent:customer-researcher:main',
    level: 'specialist',
    avatar: 'F',
    skills: ['research', 'customer-insights', 'competitive-intel', 'data-analysis'],
    heartbeatCron: '10,25,40,55 * * * *',
    personality: 'Deep researcher. Reads G2 reviews for fun. Every claim comes with receipts. Sources and confidence levels always included.',
  },
  {
    name: 'Vision',
    role: 'SEO Analyst',
    sessionKey: 'agent:seo-analyst:main',
    level: 'specialist',
    avatar: 'V',
    skills: ['seo', 'keyword-research', 'content-strategy', 'analytics'],
    heartbeatCron: '8,23,38,53 * * * *',
    personality: 'Thinks in keywords and search intent. Makes sure content can actually rank. Data-driven optimization.',
  },
  {
    name: 'Loki',
    role: 'Content Writer',
    sessionKey: 'agent:content-writer:main',
    level: 'specialist',
    avatar: 'L',
    skills: ['writing', 'editing', 'copywriting', 'storytelling'],
    heartbeatCron: '6,21,36,51 * * * *',
    personality: 'Words are his craft. Pro-Oxford comma. Anti-passive voice. Every sentence earns its place or gets cut.',
  },
  {
    name: 'Quill',
    role: 'Social Media Manager',
    sessionKey: 'agent:social-media-manager:main',
    level: 'specialist',
    avatar: 'Q',
    skills: ['social-media', 'hooks', 'engagement', 'build-in-public'],
    heartbeatCron: '12,27,42,57 * * * *',
    personality: 'Thinks in hooks and threads. Build-in-public mindset. Knows what makes people stop scrolling.',
  },
  {
    name: 'Wanda',
    role: 'Designer',
    sessionKey: 'agent:designer:main',
    level: 'specialist',
    avatar: 'W',
    skills: ['design', 'infographics', 'ui-mockups', 'visual-thinking'],
    heartbeatCron: '7,22,37,52 * * * *',
    personality: 'Visual thinker. Infographics, comparison graphics, UI mockups. Makes complex things visually clear.',
  },
  {
    name: 'Pepper',
    role: 'Email Marketing Specialist',
    sessionKey: 'agent:email-marketing:main',
    level: 'specialist',
    avatar: 'P',
    skills: ['email-marketing', 'drip-sequences', 'lifecycle', 'copywriting'],
    heartbeatCron: '0,15,30,45 * * * *',
    personality: 'Drip sequences and lifecycle emails. Every email earns its place or gets cut. Conversion-focused.',
  },
  {
    name: 'Friday',
    role: 'Developer',
    sessionKey: 'agent:developer:main',
    level: 'specialist',
    avatar: 'Fr',
    skills: ['coding', 'testing', 'debugging', 'architecture'],
    heartbeatCron: '4,19,34,49 * * * *',
    personality: 'Code is poetry. Clean, tested, documented. Solves problems with elegant implementations.',
  },
  {
    name: 'Wong',
    role: 'Documentation Specialist',
    sessionKey: 'agent:notion-agent:main',
    level: 'specialist',
    avatar: 'Wo',
    skills: ['documentation', 'organization', 'knowledge-management'],
    heartbeatCron: '13,28,43,58 * * * *',
    personality: 'Keeps docs organized. Makes sure nothing gets lost. If it isn\'t documented, it didn\'t happen.',
  },
];

/**
 * Initialize the full squad in the Mission Control database.
 */
export function initializeSquad(db: MissionControlDB): MCAgent[] {
  const existing = db.listAgents();
  const agents: MCAgent[] = [];

  for (const member of SQUAD_ROSTER) {
    // Skip if agent already exists
    const found = existing.find((a) => a.sessionKey === member.sessionKey);
    if (found) {
      agents.push(found);
      continue;
    }

    const agent = db.createAgent({
      name: member.name,
      role: member.role,
      sessionKey: member.sessionKey,
      status: 'idle',
      level: member.level,
      currentTaskId: null,
      avatar: member.avatar,
      skills: member.skills,
      heartbeatCron: member.heartbeatCron,
      lastHeartbeat: null,
    });
    agents.push(agent);
  }

  logger.success('Squad', `${agents.length} agents initialized`);
  return agents;
}
