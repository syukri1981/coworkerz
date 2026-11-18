import { db } from "@/db";
import {
  conversationMessages,
  deliberationSessions,
  knowledgeEntries,
  opencodeConfigs,
  type OpencodeConfig,
} from "@/db/schema";
import { sql, asc } from "drizzle-orm";

let initializedPromise: Promise<void> | null = null;

export async function ensureBoardroomInitialized(): Promise<void> {
  if (!initializedPromise) {
    initializedPromise = runInitialization().catch((err) => {
      initializedPromise = null;
      throw err;
    });
  }
  return initializedPromise;
}

async function runInitialization(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS deliberation_sessions (
      id SERIAL PRIMARY KEY,
      ceo_question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      auto_walk_and_talk BOOLEAN NOT NULL DEFAULT true,
      turn_count INTEGER NOT NULL DEFAULT 0,
      executive_summary TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES deliberation_sessions(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL,
      target_role TEXT NOT NULL DEFAULT 'ALL',
      interaction_mode TEXT NOT NULL DEFAULT 'walk_and_talk',
      room_zone TEXT NOT NULL DEFAULT 'strategy-table',
      content TEXT NOT NULL,
      model_used TEXT NOT NULL DEFAULT 'opencode/deepseek-v4.1-flash-free',
      provider_mode TEXT NOT NULL DEFAULT 'opencode-live',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES deliberation_sessions(id) ON DELETE SET NULL,
      source_message_id INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
      contributor_role TEXT NOT NULL,
      collaborator_role TEXT,
      topic TEXT NOT NULL,
      insight TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'cross-functional',
      confidence_score INTEGER NOT NULL DEFAULT 91,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      applied_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS opencode_configs (
      id SERIAL PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT 'https://opencode.ai/inference/openai/v1',
      api_key TEXT NOT NULL DEFAULT '',
      cto_model TEXT NOT NULL DEFAULT 'opencode/deepseek-v4.1-flash-free',
      cfo_model TEXT NOT NULL DEFAULT 'opencode/mimo-v2.6-flash-free',
      coo_model TEXT NOT NULL DEFAULT 'opencode/nemotron-3.5-lightning-free',
      temperature TEXT NOT NULL DEFAULT '0.65',
      walk_talk_rounds INTEGER NOT NULL DEFAULT 4,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ceo_persona (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT 'CEO',
      version INTEGER NOT NULL DEFAULT 0,
      markdown TEXT NOT NULL DEFAULT '',
      profile JSONB,
      analyzed_message_count INTEGER NOT NULL DEFAULT 0,
      provider_mode TEXT NOT NULL DEFAULT 'opencode-local-runtime',
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS persona_revisions (
      id SERIAL PRIMARY KEY,
      version INTEGER NOT NULL,
      change_summary TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      session_id INTEGER REFERENCES deliberation_sessions(id) ON DELETE SET NULL,
      markdown TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS executive_memories (
      id SERIAL PRIMARY KEY,
      executive_role TEXT NOT NULL,
      session_id INTEGER REFERENCES deliberation_sessions(id) ON DELETE SET NULL,
      session_question TEXT,
      source_message_id INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
      memory_type TEXT NOT NULL,
      counterpart_role TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  const existingConfigs = await db
    .select()
    .from(opencodeConfigs)
    .orderBy(asc(opencodeConfigs.id))
    .limit(1);

  if (existingConfigs.length === 0) {
    await db.insert(opencodeConfigs).values({
      baseUrl:
        process.env.OPENCODE_BASE_URL ||
        "https://opencode.ai/inference/openai/v1",
      apiKey: process.env.OPENCODE_API_KEY || "",
      ctoModel: "opencode/deepseek-v4.1-flash-free",
      cfoModel: "opencode/mimo-v2.6-flash-free",
      cooModel: "opencode/nemotron-3.5-lightning-free",
      temperature: "0.65",
      walkTalkRounds: 4,
    });
  }

  const existingSessions = await db
    .select()
    .from(deliberationSessions)
    .limit(1);

  if (existingSessions.length === 0) {
    const initialQuestion =
      "Should we allocate $4.8M this quarter to build dedicated sovereign AI inference clusters or scale via multi-cloud GPU commitments while expanding enterprise sales in Europe?";

    const [seededSession] = await db
      .insert(deliberationSessions)
      .values({
        ceoQuestion: initialQuestion,
        status: "completed",
        autoWalkAndTalk: true,
        turnCount: 4,
        executiveSummary:
          "Adopt a hybrid sovereign-edge + multi-cloud burst architecture: deploy $1.9M in Frankfurt EU-sovereign inference nodes first to unlock GDPR/DORA pipeline, retain $2.9M in flexible multi-cloud commit tranches gated by <11-month payback, and staff two EU deployment tiger pods.",
      })
      .returning();

    await db.insert(conversationMessages).values({
      sessionId: seededSession.id,
      senderRole: "CEO",
      targetRole: "ALL",
      interactionMode: "ceo_directive",
      roomZone: "ceo-briefing",
      content: initialQuestion,
      modelUsed: "ceo-command",
      providerMode: "human-ceo",
    });

    const [msg1] = await db
      .insert(conversationMessages)
      .values({
        sessionId: seededSession.id,
        senderRole: "CTO",
        targetRole: "CFO",
        interactionMode: "walk_and_talk",
        roomZone: "strategy-table",
        content:
          "Marcus, evaluating the CEO's $4.8M sovereign vs. multi-cloud question, going 100% bare-metal upfront locks us into single-generation silicon. If we place $1.9M into quantized EU sovereign inference racks in Frankfurt for regulated workloads and route elastic spikes over multi-cloud Kubernetes, we cut p95 latency by 41% without idle GPU waste.",
        modelUsed: "opencode/deepseek-v4.1-flash-free",
        providerMode: "opencode-local-runtime",
      })
      .returning();

    const [msg2] = await db
      .insert(conversationMessages)
      .values({
        sessionId: seededSession.id,
        senderRole: "CFO",
        targetRole: "COO",
        interactionMode: "walk_and_talk",
        roomZone: "window-lounge",
        content:
          "Sophia, Elena's $1.9M / $2.9M split improves our cash conversion cycle dramatically—saving 340 bps of gross margin compared to a $4.8M upfront CAPEX outlay. If I structure the remaining $2.9M multi-cloud commit in two ARR-linked tranches with a 10.5-month payback gate, how fast can Operations convert our European enterprise pipeline?",
        modelUsed: "opencode/mimo-v2.6-flash-free",
        providerMode: "opencode-local-runtime",
      })
      .returning();

    const [msg3] = await db
      .insert(conversationMessages)
      .values({
        sessionId: seededSession.id,
        senderRole: "COO",
        targetRole: "CTO",
        interactionMode: "walk_and_talk",
        roomZone: "tech-wall",
        content:
          "Elena, DACH and French enterprise buyers stall 6–8 weeks in security review unless EU data residency is live. Standing up your Frankfurt sovereign cluster first lets my two EMEA solutions pods compress enterprise onboarding under 14 days and unlock $11.5M in late-stage European ARR this quarter.",
        modelUsed: "opencode/nemotron-3.5-lightning-free",
        providerMode: "opencode-local-runtime",
      })
      .returning();

    const [msg4] = await db
      .insert(conversationMessages)
      .values({
        sessionId: seededSession.id,
        senderRole: "COO",
        targetRole: "CEO",
        interactionMode: "executive_consensus",
        roomZone: "ceo-briefing",
        content:
          "CEO, after walking through technical topology, capital tranches, and EMEA readiness together, we recommend a hybrid $1.9M Frankfurt sovereign cluster + $2.9M performance-gated multi-cloud burst plan. This protects 75%+ gross margins, clears EU data-residency procurement immediately, and accelerates Q3 European enterprise bookings.",
        modelUsed: "opencode/nemotron-3.5-lightning-free",
        providerMode: "opencode-local-runtime",
      })
      .returning();

    await db.insert(knowledgeEntries).values([
      {
        sessionId: seededSession.id,
        sourceMessageId: msg1.id,
        contributorRole: "CTO",
        collaboratorRole: "CFO",
        topic: "Hybrid Sovereign Base + Multi-Cloud Burst Topology",
        insight:
          "Sizing dedicated sovereign GPU capacity to steady-state regulated baseline (~40% of budget) while bursting peak inference across multi-cloud Kubernetes cuts p95 latency 41% and eliminates silicon underutilization.",
        category: "architecture",
        confidenceScore: 94,
        tags: ["sovereign-ai", "multi-cloud", "eu-latency"],
        appliedCount: 2,
      },
      {
        sessionId: seededSession.id,
        sourceMessageId: msg2.id,
        contributorRole: "CFO",
        collaboratorRole: "COO",
        topic: "40/60 Tranche Capital Guardrail (<11-Month Payback)",
        insight:
          "Splitting infrastructure commitments into a 40% foundational tranche and 60% ARR-milestone burst credits preserves 340 bps of gross margin and insulates free cash flow.",
        category: "finance",
        confidenceScore: 95,
        tags: ["capital-allocation", "gross-margin", "capex-vs-opex"],
        appliedCount: 2,
      },
      {
        sessionId: seededSession.id,
        sourceMessageId: msg3.id,
        contributorRole: "COO",
        collaboratorRole: "CTO",
        topic: "EU Data-Residency Pre-Clearance Accelerates EMEA Close",
        insight:
          "Deploying Frankfurt sovereign inference nodes alongside two dedicated EMEA solutions pods removes 6–8 weeks of GDPR/DORA procurement friction and keeps onboarding under 14 days.",
        category: "operations",
        confidenceScore: 92,
        tags: ["emea-gtm", "gdpr-dora", "onboarding-sla"],
        appliedCount: 1,
      },
      {
        sessionId: seededSession.id,
        sourceMessageId: msg4.id,
        contributorRole: "JOINT",
        collaboratorRole: "ALL",
        topic: "Synchronized Infra-Finance-GTM Expansion Playbook",
        insight:
          "Tie regional sovereign AI node activation directly to tranche-gated cloud commitments and localized tiger pods to scale international ARR without margin dilution.",
        category: "cross-functional",
        confidenceScore: 96,
        tags: ["c-suite-consensus", "europe-expansion", "ai-clusters"],
        appliedCount: 3,
      },
    ]);
  }
}

export async function getActiveOpencodeConfig(): Promise<OpencodeConfig> {
  await ensureBoardroomInitialized();
  const rows = await db
    .select()
    .from(opencodeConfigs)
    .orderBy(asc(opencodeConfigs.id))
    .limit(1);
  return rows[0];
}
