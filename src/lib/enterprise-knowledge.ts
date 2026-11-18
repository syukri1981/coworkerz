import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { NextRequest } from "next/server";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  ceoPersona,
  conversationMessages,
  ekApiKeys,
  ekChunks,
  ekDocuments,
  ekDomains,
  ekEntities,
  ekRelationships,
  ekTaxonomySchemes,
  executiveMemories,
  knowledgeEntries,
  type ClearanceLevel,
  type DocumentClassificationTag,
  type EkDocument,
  type EkDomain,
  type EkEntity,
  type EkRelationship,
  type EkTaxonomyScheme,
  type EnterpriseDocMetadata,
  type PrincipalRole,
  type SkosConcept,
} from "@/db/schema";
import {
  ensureBoardroomInitialized,
  getActiveOpencodeConfig,
} from "./bootstrap";
import {
  autoClassifyDocument,
  chunkDocumentContent,
  classifyWithSkosScheme,
  computeSemanticEmbedding,
  cosineSimilarity,
  DEFAULT_ENTERPRISE_TAXONOMY_YAML,
  exportSkosTurtle,
  lexicalBm25Score,
  parseTaxonomyYaml,
  slugifyKey,
  tokenize,
} from "./enterprise-taxonomy";
import { tryLiveOpencodeCompletion } from "./opencode";

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");

const CLEARANCE_RANK: Record<ClearanceLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  board_restricted: 3,
};

const DEFAULT_ROLE_CLEARANCE: Record<PrincipalRole, ClearanceLevel> = {
  CEO: "board_restricted",
  CFO: "board_restricted",
  CTO: "confidential",
  COO: "confidential",
  EXTERNAL_AGENT: "internal",
};

export interface AccessPrincipal {
  authType: "ceo-session" | "role-simulation" | "api-key";
  role: PrincipalRole;
  clearance: ClearanceLevel;
  allowedDomains: string[]; // ['*'] or domain keys
  canWrite: boolean;
  canReadAgentMemory: boolean;
  keyName?: string;
  keyId?: number;
}

async function writeKnowledgeMirror(
  filename: string,
  content: string
): Promise<void> {
  try {
    const target = path.join(/*turbopackIgnore: true*/ KNOWLEDGE_DIR, filename);
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(target), {
      recursive: true,
    });
    await fs.writeFile(/*turbopackIgnore: true*/ target, content, "utf8");
  } catch (err) {
    console.error(`Failed to mirror knowledge file ${filename}:`, err);
  }
}

// ============================================================================
// INITIALIZATION & SEEDING (ek_* strictly separated from agent memory)
// ============================================================================
let ekInitPromise: Promise<void> | null = null;

export function ensureEnterpriseKnowledgeInitialized(): Promise<void> {
  if (!ekInitPromise) {
    ekInitPromise = runEkInit().catch((err) => {
      ekInitPromise = null;
      throw err;
    });
  }
  return ekInitPromise;
}

async function runEkInit(): Promise<void> {
  await ensureBoardroomInitialized();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_domains (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      owner_role TEXT NOT NULL DEFAULT 'CEO',
      color_hex TEXT NOT NULL DEFAULT '#2563EB',
      default_clearance TEXT NOT NULL DEFAULT 'internal',
      acl_read_roles JSONB NOT NULL DEFAULT '["CEO","CTO","CFO","COO"]'::jsonb,
      acl_write_roles JSONB NOT NULL DEFAULT '["CEO"]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_taxonomy_schemes (
      id SERIAL PRIMARY KEY,
      scheme_uri TEXT NOT NULL DEFAULT 'urn:aether:enterprise:taxonomy',
      title TEXT NOT NULL DEFAULT 'Aether Enterprise SKOS/OWL Knowledge Taxonomy',
      version INTEGER NOT NULL DEFAULT 1,
      format TEXT NOT NULL DEFAULT 'yaml-skos',
      yaml_content TEXT NOT NULL,
      skos_turtle TEXT NOT NULL DEFAULT '',
      parsed_concepts JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT NOT NULL DEFAULT 'CEO',
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_documents (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'policy',
      domain_key TEXT NOT NULL REFERENCES ek_domains(key) ON DELETE RESTRICT,
      secondary_domains JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      classification_level TEXT NOT NULL DEFAULT 'internal',
      acl_read_roles JSONB NOT NULL DEFAULT '["CEO","CTO","CFO","COO"]'::jsonb,
      acl_write_roles JSONB NOT NULL DEFAULT '["CEO"]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      taxonomy_concepts JSONB NOT NULL DEFAULT '[]'::jsonb,
      classifier_mode TEXT NOT NULL DEFAULT 'skos-hybrid-classifier',
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      reviewed_by TEXT,
      reviewer_notes TEXT,
      reviewed_at TIMESTAMP,
      embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_chunks (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES ek_documents(id) ON DELETE CASCADE,
      domain_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT NOT NULL DEFAULT 'Section',
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_entities (
      id SERIAL PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'System',
      domain_key TEXT NOT NULL REFERENCES ek_domains(key) ON DELETE RESTRICT,
      taxonomy_concept_id TEXT,
      description TEXT NOT NULL,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      classification_level TEXT NOT NULL DEFAULT 'internal',
      acl_read_roles JSONB NOT NULL DEFAULT '["CEO","CTO","CFO","COO"]'::jsonb,
      source_document_id INTEGER REFERENCES ek_documents(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_relationships (
      id SERIAL PRIMARY KEY,
      source_entity_id INTEGER NOT NULL REFERENCES ek_entities(id) ON DELETE CASCADE,
      target_entity_id INTEGER NOT NULL REFERENCES ek_entities(id) ON DELETE CASCADE,
      predicate TEXT NOT NULL,
      domain_key TEXT NOT NULL REFERENCES ek_domains(key) ON DELETE RESTRICT,
      is_cross_domain BOOLEAN NOT NULL DEFAULT false,
      weight INTEGER NOT NULL DEFAULT 85,
      evidence TEXT NOT NULL DEFAULT '',
      classification_level TEXT NOT NULL DEFAULT 'internal',
      acl_read_roles JSONB NOT NULL DEFAULT '["CEO","CTO","CFO","COO"]'::jsonb,
      source_document_id INTEGER REFERENCES ek_documents(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ek_api_keys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      assigned_role TEXT NOT NULL DEFAULT 'EXTERNAL_AGENT',
      allowed_domains JSONB NOT NULL DEFAULT '["*"]'::jsonb,
      clearance_level TEXT NOT NULL DEFAULT 'internal',
      can_write BOOLEAN NOT NULL DEFAULT false,
      can_read_agent_memory BOOLEAN NOT NULL DEFAULT false,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMP,
      revoked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  // 1. Seed Domains
  const existingDomains = await db.select().from(ekDomains).limit(1);
  if (existingDomains.length === 0) {
    await db.insert(ekDomains).values([
      {
        key: "technology",
        name: "AI & Cloud Architecture",
        description:
          "Sovereign GPU clusters, multi-cloud Kubernetes elasticity, model gateways, latency SLOs, and zero-trust security RFCs.",
        ownerRole: "CTO",
        colorHex: "#2563EB",
        defaultClearance: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO", "CTO"],
      },
      {
        key: "finance",
        name: "Corporate Finance & Capital",
        description:
          "Capital allocation hurdle rates, 40/60 CAPEX/OPEX tranche gates, gross-margin floors, ARR quality, and EBITDA models.",
        ownerRole: "CFO",
        colorHex: "#0D9488",
        defaultClearance: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        aclWriteRoles: ["CEO", "CFO"],
      },
      {
        key: "operations",
        name: "Global Operations & Delivery",
        description:
          "EMEA regional tiger pods, <14-day onboarding playbooks, 99.95% enterprise SLAs, vendor tiers, and churn turnarounds.",
        ownerRole: "COO",
        colorHex: "#D97706",
        defaultClearance: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO", "COO"],
      },
      {
        key: "governance",
        name: "Legal, Risk & Regulatory",
        description:
          "EU GDPR sovereign data residency, DORA financial-sector resilience, EU AI Act model controls, and role-based ACL policy.",
        ownerRole: "CEO",
        colorHex: "#7C3AED",
        defaultClearance: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO"],
      },
      {
        key: "corporate_strategy",
        name: "Board Strategy, M&A & Pricing",
        description:
          "Board-restricted M&A due diligence, valuation term sheets, outcome-based AI packaging, and multi-year expansion OKRs.",
        ownerRole: "CEO",
        colorHex: "#E11D48",
        defaultClearance: "board_restricted",
        aclReadRoles: ["CEO", "CFO"],
        aclWriteRoles: ["CEO"],
      },
    ]);
  }

  // 2. Seed YAML/SKOS Taxonomy
  let [scheme] = await db
    .select()
    .from(ekTaxonomySchemes)
    .orderBy(desc(ekTaxonomySchemes.id))
    .limit(1);

  if (!scheme) {
    const parsed = parseTaxonomyYaml(DEFAULT_ENTERPRISE_TAXONOMY_YAML);
    const turtle = exportSkosTurtle({
      schemeUri: parsed.schemeUri,
      title: parsed.title,
      version: 1,
      concepts: parsed.concepts,
      objectProperties: parsed.objectProperties,
    });
    [scheme] = await db
      .insert(ekTaxonomySchemes)
      .values({
        schemeUri: parsed.schemeUri,
        title: parsed.title,
        version: 1,
        format: "yaml-skos",
        yamlContent: DEFAULT_ENTERPRISE_TAXONOMY_YAML,
        skosTurtle: turtle,
        parsedConcepts: parsed.concepts,
        updatedBy: "CEO",
      })
      .returning();
    await writeKnowledgeMirror(
      "taxonomy.skos.yaml",
      DEFAULT_ENTERPRISE_TAXONOMY_YAML
    );
    await writeKnowledgeMirror("taxonomy.skos.ttl", turtle);
  }

  // 3. Seed Canonical Enterprise Documents + Chunks + Domain-Tagged Knowledge Graph
  const existingDocs = await db.select().from(ekDocuments).limit(1);
  if (existingDocs.length === 0) {
    const seedDocs: Array<{
      slug: string;
      title: string;
      docType: string;
      domainKey: string;
      classificationLevel: ClearanceLevel;
      aclReadRoles: string[];
      aclWriteRoles: string[];
      reviewStatus: "approved" | "pending_review";
      reviewerNotes?: string;
      metadata: EnterpriseDocMetadata;
      content: string;
    }> = [
      {
        slug: "rfc-104-hybrid-sovereign-ai-cluster",
        title: "RFC-104: Frankfurt Sovereign AI Cluster & Multi-Cloud Burst Architecture",
        docType: "architecture_rfc",
        domainKey: "technology",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO", "CTO"],
        reviewStatus: "approved",
        reviewerNotes: "Approved by CEO & CTO as baseline EU AI topology.",
        metadata: {
          author: "Dr. Elena Vance (CTO)",
          version: "2.1",
          effectiveDate: "2026-Q3",
          region: "EU-Central (Frankfurt)",
          sourceSystem: "Architecture Board",
        },
        content: `## Sovereign Baseline Topology
Aether deploys a $1.9M dedicated sovereign GPU inference cluster in Frankfurt (eu-central-sov-1) running quantized FP8 serving racks with strict zero-retention tenant isolation. All regulated European customer prompts, embeddings, and telemetry remain inside the EU legal boundary to satisfy GDPR and DORA requirements.

## Elastic Multi-Cloud Burst & Latency SLOs
Peak non-sovereign and overflow inference traffic bursts across multi-cloud Kubernetes GPU pools via the Aether Model Gateway with streaming semantic caching. Benchmarks confirm a 41% reduction in p95 latency (from 820ms to 484ms) and 52% fewer uncached token spikes while eliminating idle single-generation silicon risk.`,
      },
      {
        slug: "fin-201-capex-tranche-margin-policy",
        title: "FIN-201: 40/60 Capital Tranche Governance & 74% Gross Margin Floor",
        docType: "financial_model",
        domainKey: "finance",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO"],
        aclWriteRoles: ["CEO", "CFO"],
        reviewStatus: "approved",
        reviewerNotes: "Approved capital allocation policy for FY2026 infrastructure & GTM bets.",
        metadata: {
          author: "Marcus Sterling (CFO)",
          version: "3.0",
          effectiveDate: "2026-Q3",
          region: "Global",
          sourceSystem: "FP&A Treasury Vault",
        },
        content: `## Tranche Release Rules
Any infrastructure or AI cloud investment exceeding $1.5M must be structured into a maximum 40% foundational commitment ($1.9M Frankfurt baseline) and a 60% milestone-gated tranche ($2.9M multi-cloud GPU commit). Tranche 2 unlocks only when trailing net dollar retention exceeds 118% and verified payback stays under 10.5 months.

## Margin & Free Cash Flow Guardrails
Consolidated SaaS + AI gross margin must remain at or above 74.5%, preserving 340 bps of EBITDA expansion versus upfront bare-metal CAPEX outlays. Per-tenant token circuit breakers enforce hard COGS ceilings on high-volume enterprise accounts.`,
      },
      {
        slug: "ops-305-emea-tiger-pods-sla-runbook",
        title: "OPS-305: EMEA Regional Tiger Pods & 14-Day Enterprise Onboarding Runbook",
        docType: "runbook",
        domainKey: "operations",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO", "COO"],
        reviewStatus: "approved",
        reviewerNotes: "Approved operational playbook for Q3 DACH & France expansion.",
        metadata: {
          author: "Sophia Alverez (COO)",
          version: "1.8",
          effectiveDate: "2026-Q3",
          region: "EMEA (DACH, France, Nordics)",
          sourceSystem: "Global Ops Handbook",
        },
        content: `## EMEA Tiger Pod Staffing & Onboarding SLA
Operations staffs two dedicated EMEA cross-functional tiger pods (solutions architect, forward-deployed AI engineer, compliance specialist) aligned to DACH and French enterprise accounts. Pre-cleared Frankfurt sovereign residency eliminates 6-8 weeks of security questionnaire stalls and holds enterprise onboarding time under 14 calendar days.

## Contractual Reliability & Pipeline Unlock
Tier-1 enterprise customers receive a 99.95% inference uptime SLA with 15-minute P1 incident escalation and automated multi-cloud failover. Executing this playbook unlocks $11.5M in late-stage Q3 European ARR within existing headcount ratios.`,
      },
      {
        slug: "pol-402-eu-gdpr-dora-ai-governance",
        title: "POL-402: EU GDPR Data Residency, DORA ICT Resilience & AI ACL Standard",
        docType: "policy",
        domainKey: "governance",
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        aclWriteRoles: ["CEO"],
        reviewStatus: "approved",
        reviewerNotes: "Mandatory enterprise compliance baseline shareable with external AI tools.",
        metadata: {
          author: "Office of General Counsel & CEO",
          version: "4.0",
          effectiveDate: "2026-Q2",
          region: "EU & Global",
          sourceSystem: "GRC Policy Registry",
        },
        content: `## GDPR Sovereign Residency & DORA Exit Controls
Regulated European banking, insurance, and public-sector workloads must process and store data exclusively on Frankfurt EU sovereign infrastructure under EU-only cryptographic keys. Under DORA Article 28, Aether maintains documented 72-hour multi-cloud exit plans, annual penetration audit attestations, and ISO 27001 / SOC 2 Type II coverage.

## Enterprise AI Knowledge Separation & ACL Mandate
Canonical enterprise knowledge documents must be strictly isolated from conversational agent memory logs. Every document, vector passage, and knowledge graph entity enforces role-based ACLs, clearance levels, and human-in-the-loop taxonomy verification under EU AI Act governance.`,
      },
      {
        slug: "memo-501-project-kestrel-ma-term-sheet",
        title: "MEMO-501: Project Kestrel $38M M&A Valuation, Earnout & PMI Playbook",
        docType: "board_memo",
        domainKey: "corporate_strategy",
        classificationLevel: "board_restricted",
        aclReadRoles: ["CEO", "CFO"],
        aclWriteRoles: ["CEO"],
        reviewStatus: "approved",
        reviewerNotes: "Strictly Board-Restricted to CEO & CFO until LOI signature.",
        metadata: {
          author: "CEO & Corporate Development",
          version: "1.2",
          effectiveDate: "2026-Q3",
          region: "North America & EU",
          sourceSystem: "Board Data Room",
        },
        content: `## Deal Structure & EBITDA Protection
Project Kestrel (65-person workflow automation & zero-trust connector startup, $7.4M ARR) is valued at $38M: $22M cash at close, $10M equity, and $6M retention/ARR earnout tied to 18-month milestones. Structure caps Year-1 EBITDA dilution at 110 bps and achieves cash-flow accretive synergy by Month 14.

## 90-Day Post-Merger Integration Gate
Technical integration isolates Kestrel's runtime behind an event-driven zero-trust adapter gateway within 45 days to avoid identity-federation technical debt, targeting $9.2M in cross-sell ARR across Aether's $82M enterprise install base.`,
      },
      {
        slug: "strat-504-agentic-tier-outcome-pricing-draft",
        title: "STRAT-504: Autonomous Agent Tier & Hybrid Outcome-Based Pricing Proposal",
        docType: "board_memo",
        domainKey: "corporate_strategy",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "CTO", "COO"],
        aclWriteRoles: ["CEO"],
        reviewStatus: "pending_review",
        metadata: {
          author: "Strategy & Monetization Working Group",
          version: "0.9-draft",
          effectiveDate: "2026-Q4",
          region: "Global",
          sourceSystem: "Pricing Committee",
        },
        content: `## Hybrid Seat + Execution Credit Model
To launch the Aether Autonomous Agent Tier without cannibalizing our $82M seat-based ARR, enterprise contracts retain 100% of core platform seats plus committed autonomous execution-credit packs priced per verified workflow outcome. Financial simulations project +7.5% gross margin expansion on top-quartile accounts and +620 bps NRR uplift.`,
      },
      {
        slug: "rfc-109-zero-trust-adapter-gateway-draft",
        title: "RFC-109: Zero-Trust Identity Federation & Semantic Cache Circuit Breakers",
        docType: "architecture_rfc",
        domainKey: "technology",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "COO"],
        aclWriteRoles: ["CEO", "CTO"],
        reviewStatus: "pending_review",
        metadata: {
          author: "Principal Security Architect",
          version: "0.7-draft",
          effectiveDate: "2026-Q3",
          region: "Global",
          sourceSystem: "Engineering RFC Queue",
        },
        content: `## Tenant Quota Circuit Breakers & Churn Defense
Introduces per-tenant token burst circuit breakers, SAML/OIDC zero-trust identity federation, and streaming semantic cache layers on the Aether Model Gateway. Designed to eliminate onboarding ingestion latency and cut enterprise AI token overages by 52%, directly addressing the churn uptick from 4.1% to 6.3%.`,
      },
    ];

    const insertedDocs = new Map<string, EkDocument>();
    for (const d of seedDocs) {
      const classified = classifyWithSkosScheme({
        title: d.title,
        content: d.content,
        concepts: scheme.parsedConcepts,
      });
      const summary = d.content
        .replace(/^##\s+.+$/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);
      const emb = computeSemanticEmbedding(`${d.title}. ${d.content}`);

      const [doc] = await db
        .insert(ekDocuments)
        .values({
          slug: d.slug,
          title: d.title,
          docType: d.docType,
          domainKey: d.domainKey,
          secondaryDomains: classified.secondaryDomains.filter(
            (x) => x !== d.domainKey
          ),
          summary,
          content: d.content,
          classificationLevel: d.classificationLevel,
          aclReadRoles: d.aclReadRoles,
          aclWriteRoles: d.aclWriteRoles,
          metadata: d.metadata,
          taxonomyConcepts: classified.tags,
          classifierMode: "skos-hybrid-classifier",
          reviewStatus: d.reviewStatus,
          reviewedBy: d.reviewStatus === "approved" ? "CEO" : null,
          reviewerNotes: d.reviewerNotes || null,
          reviewedAt: d.reviewStatus === "approved" ? new Date() : null,
          embedding: emb,
        })
        .returning();

      insertedDocs.set(d.slug, doc);

      const chunks = chunkDocumentContent(d.title, d.content);
      await db.insert(ekChunks).values(
        chunks.map((c) => ({
          documentId: doc.id,
          domainKey: d.domainKey,
          chunkIndex: c.chunkIndex,
          heading: c.heading,
          content: c.content,
          tokenCount: c.tokenCount,
          embedding: c.embedding,
        }))
      );
    }

    // 4. Seed Domain-Tagged Knowledge Graph Entities & Cross-Domain Relationships
    const docId = (slug: string) => insertedDocs.get(slug)?.id ?? null;

    const entitySeeds: Array<{
      key: string;
      name: string;
      entityType: string;
      domainKey: string;
      taxonomyConceptId: string;
      description: string;
      attributes: Record<string, string>;
      classificationLevel: ClearanceLevel;
      aclReadRoles: string[];
      docSlug: string;
    }> = [
      // Technology subgraph
      {
        key: "frankfurt-sovereign-cluster",
        name: "Frankfurt Sovereign GPU Cluster",
        entityType: "System",
        domainKey: "technology",
        taxonomyConceptId: "tech:sovereign-ai-infra",
        description:
          "Dedicated $1.9M EU-resident FP8 GPU inference cluster in Frankfurt with zero-retention tenant isolation.",
        attributes: { budget: "$1.9M", region: "eu-central-sov-1", p95Delta: "-41%" },
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "rfc-104-hybrid-sovereign-ai-cluster",
      },
      {
        key: "multicloud-k8s-burst",
        name: "Multi-Cloud K8s Inference Burst",
        entityType: "System",
        domainKey: "technology",
        taxonomyConceptId: "tech:multicloud-elasticity",
        description:
          "Elastic Kubernetes GPU burst pool with streaming semantic cache handling peak inference traffic.",
        attributes: { trancheBudget: "$2.9M", overageCut: "-52%", p95Slo: "484ms" },
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "rfc-104-hybrid-sovereign-ai-cluster",
      },
      {
        key: "zero-trust-adapter-gateway",
        name: "Zero-Trust Adapter & Quota Gateway",
        entityType: "System",
        domainKey: "technology",
        taxonomyConceptId: "tech:security-zero-trust",
        description:
          "Event-driven SAML/OIDC federation gateway and per-tenant token circuit breaker for M&A and churn defense.",
        attributes: { integrationSla: "45 days", tokenBurstCut: "-52%" },
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO"],
        docSlug: "rfc-109-zero-trust-adapter-gateway-draft",
      },
      // Finance subgraph
      {
        key: "tranche-capital-facility",
        name: "40/60 Capital Tranche Facility",
        entityType: "FinancialInstrument",
        domainKey: "finance",
        taxonomyConceptId: "fin:capex-tranche-governance",
        description:
          "Staged $4.8M capital vehicle ($1.9M base + $2.9M milestone tranche) requiring <10.5-month payback.",
        attributes: { totalEnvelope: "$4.8M", split: "40% / 60%", paybackGate: "<10.5 mo" },
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        key: "gross-margin-floor-kpi",
        name: "74.5% Gross Margin & EBITDA Floor",
        entityType: "Metric",
        domainKey: "finance",
        taxonomyConceptId: "fin:unit-economics-finops",
        description:
          "Mandatory enterprise gross-margin threshold preserving +340 bps EBITDA expansion and 118%+ NRR.",
        attributes: { grossMarginMin: "74.5%", ebitdaSavings: "+340 bps", nrrGate: ">118%" },
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        key: "core-seat-arr-base",
        name: "$82M Enterprise Seat ARR Base",
        entityType: "Metric",
        domainKey: "finance",
        taxonomyConceptId: "fin:unit-economics-finops",
        description:
          "Core recurring enterprise subscription base protected against cannibalization during AI tier expansion.",
        attributes: { arr: "$82M", churnCurrent: "6.3%", churnTarget: "<4.0%" },
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        docSlug: "strat-504-agentic-tier-outcome-pricing-draft",
      },
      // Operations subgraph
      {
        key: "emea-tiger-pods",
        name: "EMEA Solutions Tiger Pods",
        entityType: "Team",
        domainKey: "operations",
        taxonomyConceptId: "ops:emea-delivery-pods",
        description:
          "Two cross-functional European deployment squads serving DACH & French enterprise accounts.",
        attributes: { pods: "2 squads", onboardingSla: "<14 days", targetRegions: "DACH, FR" },
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      {
        key: "tier1-enterprise-sla",
        name: "Tier-1 99.95% Enterprise SLA",
        entityType: "Initiative",
        domainKey: "operations",
        taxonomyConceptId: "ops:sla-reliability",
        description:
          "Contractual 99.95% uptime, <14-day onboarding, and 15-min P1 escalation standard protecting retention.",
        attributes: { uptime: "99.95%", p1Response: "15 min", onboarding: "<14 days" },
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      // Governance subgraph
      {
        key: "eu-gdpr-residency",
        name: "EU GDPR Sovereign Data Residency",
        entityType: "Regulation",
        domainKey: "governance",
        taxonomyConceptId: "gov:eu-data-residency",
        description:
          "Binding EU boundary data processing, customer-managed EU encryption keys, and zero-retention mandate.",
        attributes: { jurisdiction: "EU / EEA", keyCustody: "EU-only HSM" },
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      {
        key: "eu-dora-act",
        name: "DORA ICT Operational Resilience",
        entityType: "Regulation",
        domainKey: "governance",
        taxonomyConceptId: "gov:dora-cyber-resilience",
        description:
          "EU financial-sector ICT third-party risk regulation requiring 72-hour cloud exit plans and audit rights.",
        attributes: { exitSla: "72 hours", certs: "ISO 27001, SOC2 II" },
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      {
        key: "eu-ai-act-acl-policy",
        name: "EU AI Act & Knowledge ACL Standard",
        entityType: "Regulation",
        domainKey: "governance",
        taxonomyConceptId: "gov:ai-safety-governance",
        description:
          "Mandates strict isolation of enterprise KB from agent memory, role ACLs, and human taxonomy review.",
        attributes: { reviewMode: "Human-in-the-Loop", isolation: "Strict Plane Split" },
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      // Corporate Strategy subgraph
      {
        key: "emea-q3-arr-expansion",
        name: "$11.5M EMEA Q3 ARR Expansion",
        entityType: "Initiative",
        domainKey: "corporate_strategy",
        taxonomyConceptId: "strat:international-expansion",
        description:
          "Late-stage regulated European enterprise bookings unlocked by sovereign residency and EMEA pods.",
        attributes: { pipelineArr: "$11.5M", horizon: "2026-Q3", closeSpeedup: "+30%" },
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      {
        key: "autonomous-agent-tier",
        name: "Aether Autonomous Agent Tier",
        entityType: "Product",
        domainKey: "corporate_strategy",
        taxonomyConceptId: "strat:agentic-pricing",
        description:
          "Hybrid platform seat + outcome-based execution credit tier projecting +7.5% margin expansion.",
        attributes: { marginLift: "+7.5%", nrrLift: "+620 bps", status: "Pending Review" },
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "CTO", "COO"],
        docSlug: "strat-504-agentic-tier-outcome-pricing-draft",
      },
      {
        key: "project-kestrel-acquisition",
        name: "Project Kestrel ($38M M&A Target)",
        entityType: "Organization",
        domainKey: "corporate_strategy",
        taxonomyConceptId: "strat:ma-corporate-dev",
        description:
          "Board-restricted 65-person workflow automation acquisition ($22M cash, $10M equity, $6M earnout).",
        attributes: { dealValue: "$38M", targetArr: "$7.4M", crossSell: "$9.2M" },
        classificationLevel: "board_restricted",
        aclReadRoles: ["CEO", "CFO"],
        docSlug: "memo-501-project-kestrel-ma-term-sheet",
      },
    ];

    const entityMap = new Map<string, EkEntity>();
    for (const e of entitySeeds) {
      const [row] = await db
        .insert(ekEntities)
        .values({
          canonicalKey: e.key,
          name: e.name,
          entityType: e.entityType,
          domainKey: e.domainKey,
          taxonomyConceptId: e.taxonomyConceptId,
          description: e.description,
          attributes: e.attributes,
          classificationLevel: e.classificationLevel,
          aclReadRoles: e.aclReadRoles,
          sourceDocumentId: docId(e.docSlug),
        })
        .returning();
      entityMap.set(e.key, row);
    }

    const relSeeds: Array<{
      from: string;
      to: string;
      predicate: string;
      domainKey: string;
      weight: number;
      evidence: string;
      classificationLevel: ClearanceLevel;
      aclReadRoles: string[];
      docSlug: string;
    }> = [
      // Intra-domain edges (build rich per-group subgraphs)
      {
        from: "frankfurt-sovereign-cluster",
        to: "multicloud-k8s-burst",
        predicate: "INTEGRATES_WITH",
        domainKey: "technology",
        weight: 95,
        evidence: "Overflows non-sovereign elastic GPU bursts via Kubernetes model router.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "rfc-104-hybrid-sovereign-ai-cluster",
      },
      {
        from: "zero-trust-adapter-gateway",
        to: "multicloud-k8s-burst",
        predicate: "MITIGATES_RISK",
        domainKey: "technology",
        weight: 90,
        evidence: "Enforces per-tenant token circuit breakers and semantic cache quotas.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO"],
        docSlug: "rfc-109-zero-trust-adapter-gateway-draft",
      },
      {
        from: "tranche-capital-facility",
        to: "gross-margin-floor-kpi",
        predicate: "GATED_BY_METRIC",
        domainKey: "finance",
        weight: 96,
        evidence: "60% burst tranche requires 74.5%+ gross margin, >118% NRR, and <10.5m payback.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        from: "gross-margin-floor-kpi",
        to: "core-seat-arr-base",
        predicate: "MITIGATES_RISK",
        domainKey: "finance",
        weight: 89,
        evidence: "Protects free cash flow and margin quality across the $82M ARR base.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        from: "emea-tiger-pods",
        to: "tier1-enterprise-sla",
        predicate: "OPERATED_BY",
        domainKey: "operations",
        weight: 92,
        evidence: "EMEA tiger pods execute <14-day onboarding and 99.95% uptime runbooks.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      {
        from: "eu-dora-act",
        to: "eu-gdpr-residency",
        predicate: "DEPENDS_ON",
        domainKey: "governance",
        weight: 91,
        evidence: "DORA financial resilience builds on EU sovereign residency & HSM key custody.",
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      // Cross-domain edges (enable multi-hop cross-domain QA across groups!)
      {
        from: "frankfurt-sovereign-cluster",
        to: "tranche-capital-facility",
        predicate: "FUNDED_BY",
        domainKey: "finance",
        weight: 97,
        evidence: "Funded via the 40% ($1.9M) foundational tranche of FIN-201.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        from: "multicloud-k8s-burst",
        to: "tranche-capital-facility",
        predicate: "FUNDED_BY",
        domainKey: "finance",
        weight: 94,
        evidence: "Funded by the $2.9M milestone-gated 60% multi-cloud tranche.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO"],
        docSlug: "fin-201-capex-tranche-margin-policy",
      },
      {
        from: "frankfurt-sovereign-cluster",
        to: "eu-gdpr-residency",
        predicate: "SATISFIES_REGULATION",
        domainKey: "governance",
        weight: 98,
        evidence: "In-region Frankfurt FP8 racks keep all EU prompts & keys within EEA.",
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      {
        from: "multicloud-k8s-burst",
        to: "eu-dora-act",
        predicate: "SATISFIES_REGULATION",
        domainKey: "governance",
        weight: 93,
        evidence: "Provides documented 72-hour DORA Article 28 multi-cloud exit resilience.",
        classificationLevel: "public",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      {
        from: "frankfurt-sovereign-cluster",
        to: "emea-tiger-pods",
        predicate: "OPERATED_BY",
        domainKey: "operations",
        weight: 91,
        evidence: "Enables EMEA solutions pods to eliminate 6-8 week security stalls.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "COO", "CTO", "CFO", "EXTERNAL_AGENT"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      {
        from: "emea-tiger-pods",
        to: "emea-q3-arr-expansion",
        predicate: "UNLOCKS_REVENUE",
        domainKey: "corporate_strategy",
        weight: 95,
        evidence: "Unlocks $11.5M in late-stage DACH and French enterprise ARR in Q3.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "COO", "CTO"],
        docSlug: "ops-305-emea-tiger-pods-sla-runbook",
      },
      {
        from: "zero-trust-adapter-gateway",
        to: "tier1-enterprise-sla",
        predicate: "MITIGATES_RISK",
        domainKey: "operations",
        weight: 89,
        evidence: "Eliminates onboarding latency & token overages driving 6.3% churn.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "COO", "CFO"],
        docSlug: "rfc-109-zero-trust-adapter-gateway-draft",
      },
      {
        from: "autonomous-agent-tier",
        to: "core-seat-arr-base",
        predicate: "GATED_BY_METRIC",
        domainKey: "corporate_strategy",
        weight: 92,
        evidence: "Hybrid seat + outcome credits prevent cannibalization of $82M seat ARR.",
        classificationLevel: "confidential",
        aclReadRoles: ["CEO", "CFO", "CTO", "COO"],
        docSlug: "strat-504-agentic-tier-outcome-pricing-draft",
      },
      {
        from: "autonomous-agent-tier",
        to: "eu-ai-act-acl-policy",
        predicate: "GOVERNED_BY_POLICY",
        domainKey: "governance",
        weight: 90,
        evidence: "Enforces role-based ACLs and separation of enterprise KB from agent memory.",
        classificationLevel: "internal",
        aclReadRoles: ["CEO", "CTO", "CFO", "COO", "EXTERNAL_AGENT"],
        docSlug: "pol-402-eu-gdpr-dora-ai-governance",
      },
      {
        from: "project-kestrel-acquisition",
        to: "zero-trust-adapter-gateway",
        predicate: "INTEGRATES_WITH",
        domainKey: "corporate_strategy",
        weight: 94,
        evidence: "Isolates Kestrel runtime behind zero-trust gateway in 45-day PMI gate.",
        classificationLevel: "board_restricted",
        aclReadRoles: ["CEO", "CFO"],
        docSlug: "memo-501-project-kestrel-ma-term-sheet",
      },
      {
        from: "project-kestrel-acquisition",
        to: "gross-margin-floor-kpi",
        predicate: "GATED_BY_METRIC",
        domainKey: "finance",
        weight: 93,
        evidence: "$6M earnout caps Year-1 EBITDA dilution at 110 bps; accretive Month 14.",
        classificationLevel: "board_restricted",
        aclReadRoles: ["CEO", "CFO"],
        docSlug: "memo-501-project-kestrel-ma-term-sheet",
      },
    ];

    for (const r of relSeeds) {
      const s = entityMap.get(r.from);
      const t = entityMap.get(r.to);
      if (!s || !t) continue;
      await db.insert(ekRelationships).values({
        sourceEntityId: s.id,
        targetEntityId: t.id,
        predicate: r.predicate,
        domainKey: r.domainKey,
        isCrossDomain: s.domainKey !== t.domainKey,
        weight: r.weight,
        evidence: r.evidence,
        classificationLevel: r.classificationLevel,
        aclReadRoles: r.aclReadRoles,
        sourceDocumentId: docId(r.docSlug),
      });
    }
  }
}

// ============================================================================
// ACL & EXTERNAL AI TOOL AUTHENTICATION
// ============================================================================
const VALID_ROLES = new Set<PrincipalRole>([
  "CEO",
  "CTO",
  "CFO",
  "COO",
  "EXTERNAL_AGENT",
]);

function normalizeClearance(val: string | undefined | null): ClearanceLevel {
  if (
    val === "public" ||
    val === "internal" ||
    val === "confidential" ||
    val === "board_restricted"
  ) {
    return val;
  }
  return "internal";
}

export function makeRolePrincipal(
  role: PrincipalRole,
  authType: AccessPrincipal["authType"] = "role-simulation"
): AccessPrincipal {
  return {
    authType,
    role,
    clearance: DEFAULT_ROLE_CLEARANCE[role],
    allowedDomains: ["*"],
    canWrite: role === "CEO" || role === "CTO" || role === "CFO" || role === "COO",
    canReadAgentMemory: role === "CEO",
  };
}

export async function resolvePrincipal(
  req: NextRequest
): Promise<{ principal: AccessPrincipal; error?: string }> {
  await ensureEnterpriseKnowledgeInitialized();

  const authHeader = req.headers.get("authorization") || "";
  const xApiKey = req.headers.get("x-api-key") || "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const rawKey = (xApiKey || bearerToken).trim();

  if (rawKey) {
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const [keyRow] = await db
      .select()
      .from(ekApiKeys)
      .where(eq(ekApiKeys.keyHash, hash))
      .limit(1);

    if (!keyRow || keyRow.revoked) {
      return {
        principal: makeRolePrincipal("EXTERNAL_AGENT", "api-key"),
        error: "Invalid or revoked Enterprise Knowledge API key.",
      };
    }

    await db
      .update(ekApiKeys)
      .set({
        requestCount: sql`${ekApiKeys.requestCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(eq(ekApiKeys.id, keyRow.id));

    const role = VALID_ROLES.has(keyRow.assignedRole as PrincipalRole)
      ? (keyRow.assignedRole as PrincipalRole)
      : "EXTERNAL_AGENT";

    return {
      principal: {
        authType: "api-key",
        role,
        clearance: normalizeClearance(keyRow.clearanceLevel),
        allowedDomains:
          Array.isArray(keyRow.allowedDomains) && keyRow.allowedDomains.length > 0
            ? keyRow.allowedDomains
            : ["*"],
        canWrite: keyRow.canWrite,
        canReadAgentMemory: keyRow.canReadAgentMemory,
        keyName: keyRow.name,
        keyId: keyRow.id,
      },
    };
  }

  // CEO interactive console — allows optional ACL view simulation via ?asRole= or X-Simulate-Role
  const simParam = (
    req.nextUrl.searchParams.get("asRole") ||
    req.headers.get("x-simulate-role") ||
    ""
  )
    .trim()
    .toUpperCase();

  if (simParam && VALID_ROLES.has(simParam as PrincipalRole) && simParam !== "CEO") {
    return {
      principal: makeRolePrincipal(simParam as PrincipalRole, "role-simulation"),
    };
  }

  return { principal: makeRolePrincipal("CEO", "ceo-session") };
}

export function canPrincipalRead(
  principal: AccessPrincipal,
  item: {
    domainKey: string;
    classificationLevel: string;
    aclReadRoles: string[];
  }
): boolean {
  // Domain scope check (for domain-scoped API keys)
  if (
    !principal.allowedDomains.includes("*") &&
    !principal.allowedDomains.includes(item.domainKey)
  ) {
    return false;
  }

  // CEO session with unrestricted domain always has full visibility
  if (principal.role === "CEO" && principal.clearance === "board_restricted") {
    return true;
  }

  // Clearance level check
  const itemRank = CLEARANCE_RANK[normalizeClearance(item.classificationLevel)];
  const callerRank = CLEARANCE_RANK[principal.clearance];
  if (callerRank < itemRank) return false;

  // Explicit ACL role list check
  const roles = Array.isArray(item.aclReadRoles) ? item.aclReadRoles : [];
  return roles.includes("*") || roles.includes(principal.role);
}

// ============================================================================
// TAXONOMY MANAGEMENT (YAML + SKOS/OWL TURTLE)
// ============================================================================
export async function getActiveTaxonomyScheme(): Promise<EkTaxonomyScheme> {
  await ensureEnterpriseKnowledgeInitialized();
  const [scheme] = await db
    .select()
    .from(ekTaxonomySchemes)
    .orderBy(desc(ekTaxonomySchemes.id))
    .limit(1);
  return scheme;
}

export async function updateTaxonomyScheme(params: {
  yamlContent: string;
  updatedBy?: string;
  reclassifyAll?: boolean;
}): Promise<{
  scheme: EkTaxonomyScheme;
  warnings: string[];
  reclassifiedCount: number;
}> {
  await ensureEnterpriseKnowledgeInitialized();
  const parsed = parseTaxonomyYaml(params.yamlContent);
  const current = await getActiveTaxonomyScheme();
  const nextVersion = (current?.version || 0) + 1;
  const turtle = exportSkosTurtle({
    schemeUri: parsed.schemeUri,
    title: parsed.title,
    version: nextVersion,
    concepts: parsed.concepts,
    objectProperties: parsed.objectProperties,
  });

  const [saved] = await db
    .insert(ekTaxonomySchemes)
    .values({
      schemeUri: parsed.schemeUri,
      title: parsed.title,
      version: nextVersion,
      format: "yaml-skos",
      yamlContent: params.yamlContent,
      skosTurtle: turtle,
      parsedConcepts: parsed.concepts,
      updatedBy: params.updatedBy || "CEO",
      updatedAt: new Date(),
    })
    .returning();

  await writeKnowledgeMirror("taxonomy.skos.yaml", params.yamlContent);
  await writeKnowledgeMirror("taxonomy.skos.ttl", turtle);

  let reclassifiedCount = 0;
  if (params.reclassifyAll) {
    const docs = await db.select().from(ekDocuments);
    for (const doc of docs) {
      const res = classifyWithSkosScheme({
        title: doc.title,
        content: doc.content,
        concepts: parsed.concepts,
      });
      await db
        .update(ekDocuments)
        .set({
          taxonomyConcepts: res.tags,
          secondaryDomains: res.secondaryDomains.filter(
            (d) => d !== doc.domainKey
          ),
          reviewStatus:
            doc.reviewStatus === "approved" ? "pending_review" : doc.reviewStatus,
          updatedAt: new Date(),
        })
        .where(eq(ekDocuments.id, doc.id));
      reclassifiedCount++;
    }
  }

  return { scheme: saved, warnings: parsed.warnings, reclassifiedCount };
}

// ============================================================================
// DOCUMENT INGESTION, AUTO-CLASSIFICATION & HUMAN-IN-THE-LOOP REVIEW
// ============================================================================
export async function ingestEnterpriseDocument(params: {
  title: string;
  content: string;
  docType?: string;
  domainKey?: string; // optional — auto-assigned by SKOS classifier if omitted or 'auto'
  classificationLevel?: ClearanceLevel;
  aclReadRoles?: string[];
  aclWriteRoles?: string[];
  metadata?: EnterpriseDocMetadata;
  autoApprove?: boolean;
  extractGraph?: boolean;
}): Promise<{
  document: EkDocument;
  chunkCount: number;
  createdEntities: number;
  createdRelationships: number;
}> {
  await ensureEnterpriseKnowledgeInitialized();
  const [scheme, config, domains] = await Promise.all([
    getActiveTaxonomyScheme(),
    getActiveOpencodeConfig(),
    db.select().from(ekDomains),
  ]);
  const domainMap = new Map(domains.map((d) => [d.key, d]));

  const classified = await autoClassifyDocument({
    title: params.title,
    content: params.content,
    concepts: scheme.parsedConcepts,
    config,
  });

  const resolvedDomain =
    params.domainKey &&
    params.domainKey !== "auto" &&
    domainMap.has(params.domainKey)
      ? params.domainKey
      : domainMap.has(classified.suggestedDomain)
      ? classified.suggestedDomain
      : "corporate_strategy";

  const domDefaults = domainMap.get(resolvedDomain)!;
  const clearance = normalizeClearance(
    params.classificationLevel || domDefaults.defaultClearance
  );
  const aclRead =
    Array.isArray(params.aclReadRoles) && params.aclReadRoles.length > 0
      ? Array.from(new Set(["CEO", ...params.aclReadRoles]))
      : domDefaults.aclReadRoles;
  const aclWrite =
    Array.isArray(params.aclWriteRoles) && params.aclWriteRoles.length > 0
      ? Array.from(new Set(["CEO", ...params.aclWriteRoles]))
      : domDefaults.aclWriteRoles;

  const baseSlug = slugifyKey(params.title);
  const uniqueSlug = `${baseSlug}-${Date.now().toString(36).slice(-4)}`;
  const embedding = computeSemanticEmbedding(
    `${params.title}. ${params.content}`
  );

  const approveNow = Boolean(params.autoApprove);

  const [doc] = await db
    .insert(ekDocuments)
    .values({
      slug: uniqueSlug,
      title: params.title.trim(),
      docType: (params.docType || "policy").trim(),
      domainKey: resolvedDomain,
      secondaryDomains: classified.secondaryDomains.filter(
        (d) => d !== resolvedDomain && domainMap.has(d)
      ),
      summary: classified.summary,
      content: params.content.trim(),
      classificationLevel: clearance,
      aclReadRoles: aclRead,
      aclWriteRoles: aclWrite,
      metadata: {
        author: "CEO / Enterprise Ingest",
        version: "1.0",
        effectiveDate: new Date().toISOString().slice(0, 10),
        ...params.metadata,
      },
      taxonomyConcepts: classified.tags,
      classifierMode: classified.classifierMode,
      reviewStatus: approveNow ? "approved" : "pending_review",
      reviewedBy: approveNow ? "CEO" : null,
      reviewerNotes: approveNow ? "Direct CEO approval on ingest." : null,
      reviewedAt: approveNow ? new Date() : null,
      embedding,
    })
    .returning();

  const chunks = chunkDocumentContent(doc.title, doc.content);
  if (chunks.length > 0) {
    await db.insert(ekChunks).values(
      chunks.map((c) => ({
        documentId: doc.id,
        domainKey: resolvedDomain,
        chunkIndex: c.chunkIndex,
        heading: c.heading,
        content: c.content,
        tokenCount: c.tokenCount,
        embedding: c.embedding,
      }))
    );
  }

  let createdEntities = 0;
  let createdRelationships = 0;

  if (params.extractGraph !== false) {
    const nameToEntity = new Map<string, EkEntity>();
    for (const ent of classified.extractedEntities) {
      const eDomain = domainMap.has(ent.domainKey)
        ? ent.domainKey
        : resolvedDomain;
      const cKey = slugifyKey(ent.name);
      const [existing] = await db
        .select()
        .from(ekEntities)
        .where(eq(ekEntities.canonicalKey, cKey))
        .limit(1);

      if (existing) {
        nameToEntity.set(ent.name.toLowerCase(), existing);
      } else {
        const [inserted] = await db
          .insert(ekEntities)
          .values({
            canonicalKey: cKey,
            name: ent.name,
            entityType: ent.entityType || "Initiative",
            domainKey: eDomain,
            taxonomyConceptId: ent.taxonomyConceptId,
            description: ent.description,
            attributes: ent.attributes || {},
            classificationLevel: clearance,
            aclReadRoles: aclRead,
            sourceDocumentId: doc.id,
          })
          .returning();
        nameToEntity.set(ent.name.toLowerCase(), inserted);
        createdEntities++;
      }
    }

    for (const rel of classified.extractedRelationships) {
      const sEnt = nameToEntity.get(rel.sourceName.toLowerCase());
      const tEnt = nameToEntity.get(rel.targetName.toLowerCase());
      if (!sEnt || !tEnt || sEnt.id === tEnt.id) continue;
      const rDomain = domainMap.has(rel.domainKey)
        ? rel.domainKey
        : resolvedDomain;
      await db.insert(ekRelationships).values({
        sourceEntityId: sEnt.id,
        targetEntityId: tEnt.id,
        predicate: rel.predicate || "INTEGRATES_WITH",
        domainKey: rDomain,
        isCrossDomain: sEnt.domainKey !== tEnt.domainKey,
        weight: 85,
        evidence: rel.evidence,
        classificationLevel: clearance,
        aclReadRoles: aclRead,
        sourceDocumentId: doc.id,
      });
      createdRelationships++;
    }
  }

  return {
    document: doc,
    chunkCount: chunks.length,
    createdEntities,
    createdRelationships,
  };
}

export async function reviewEnterpriseDocument(params: {
  documentId: number;
  reviewStatus?: "approved" | "pending_review" | "rejected";
  conceptIds?: string[]; // optional human override of SKOS concept IDs
  domainKey?: string;
  classificationLevel?: ClearanceLevel;
  aclReadRoles?: string[];
  reviewerNotes?: string;
  reviewedBy?: string;
}): Promise<EkDocument | null> {
  await ensureEnterpriseKnowledgeInitialized();
  const [existing] = await db
    .select()
    .from(ekDocuments)
    .where(eq(ekDocuments.id, params.documentId))
    .limit(1);
  if (!existing) return null;

  let nextTags: DocumentClassificationTag[] = existing.taxonomyConcepts;
  let classifierMode = existing.classifierMode;

  if (Array.isArray(params.conceptIds)) {
    const scheme = await getActiveTaxonomyScheme();
    const map = new Map(scheme.parsedConcepts.map((c) => [c.id, c]));
    const prevMap = new Map(
      existing.taxonomyConcepts.map((t) => [t.conceptId, t])
    );
    nextTags = params.conceptIds
      .map((id) => {
        const c = map.get(id);
        if (!c) return null;
        const prev = prevMap.get(id);
        return {
          conceptId: c.id,
          prefLabel: c.prefLabel,
          domainKey: c.domainKey,
          uri: c.uri,
          confidence: prev ? Math.max(prev.confidence, 95) : 100,
          matchedSignals: prev ? prev.matchedSignals : ["ceo-curated"],
          origin: prev ? prev.origin : ("human-reviewer" as const),
        };
      })
      .filter((x): x is DocumentClassificationTag => x !== null);
    classifierMode = "human-curated";
  }

  const nextDomain = params.domainKey || existing.domainKey;
  const nextSecondary = Array.from(
    new Set(nextTags.map((t) => t.domainKey).filter((d) => d !== nextDomain))
  );
  const nextAcl =
    Array.isArray(params.aclReadRoles) && params.aclReadRoles.length > 0
      ? Array.from(new Set(["CEO", ...params.aclReadRoles]))
      : existing.aclReadRoles;
  const nextClearance = params.classificationLevel
    ? normalizeClearance(params.classificationLevel)
    : existing.classificationLevel;
  const nextStatus = params.reviewStatus || existing.reviewStatus;

  const [updated] = await db
    .update(ekDocuments)
    .set({
      domainKey: nextDomain,
      secondaryDomains: nextSecondary,
      taxonomyConcepts: nextTags,
      classifierMode,
      classificationLevel: nextClearance,
      aclReadRoles: nextAcl,
      reviewStatus: nextStatus,
      reviewedBy: params.reviewedBy || "CEO",
      reviewerNotes:
        params.reviewerNotes !== undefined
          ? params.reviewerNotes
          : existing.reviewerNotes,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ekDocuments.id, existing.id))
    .returning();

  if (nextDomain !== existing.domainKey) {
    await db
      .update(ekChunks)
      .set({ domainKey: nextDomain })
      .where(eq(ekChunks.documentId, existing.id));
  }

  return updated;
}

// ============================================================================
// DOMAIN-TAGGED & CROSS-DOMAIN KNOWLEDGE GRAPH SERVICE
// ============================================================================
export interface EnrichedRelationship extends EkRelationship {
  sourceName: string;
  sourceDomain: string;
  targetName: string;
  targetDomain: string;
}

export async function queryKnowledgeGraph(params: {
  principal: AccessPrincipal;
  domain?: string | null; // single domain subgraph, or 'ALL'
  domains?: string[]; // multiple domains
  includeCrossDomainBridges?: boolean;
  onlyCrossDomain?: boolean;
  seedQuery?: string | null;
  hops?: number;
}): Promise<{
  domains: EkDomain[];
  entities: EkEntity[];
  relationships: EnrichedRelationship[];
  stats: {
    visibleEntities: number;
    visibleRelationships: number;
    crossDomainRelationships: number;
    aclRedactedEntities: number;
    aclRedactedRelationships: number;
    entitiesPerDomain: Record<string, number>;
  };
}> {
  await ensureEnterpriseKnowledgeInitialized();
  const [domains, allEntities, allRels] = await Promise.all([
    db.select().from(ekDomains).orderBy(asc(ekDomains.id)),
    db.select().from(ekEntities).orderBy(asc(ekEntities.id)),
    db.select().from(ekRelationships).orderBy(asc(ekRelationships.id)),
  ]);

  // 1. Enforce ACL on every entity and relationship
  const permittedEntities = allEntities.filter((e) =>
    canPrincipalRead(params.principal, e)
  );
  const permittedEntityMap = new Map(permittedEntities.map((e) => [e.id, e]));
  const aclRedactedEntities = allEntities.length - permittedEntities.length;

  const permittedRels: EnrichedRelationship[] = [];
  let aclRedactedRelationships = 0;

  for (const r of allRels) {
    const src = permittedEntityMap.get(r.sourceEntityId);
    const tgt = permittedEntityMap.get(r.targetEntityId);
    if (!src || !tgt || !canPrincipalRead(params.principal, r)) {
      aclRedactedRelationships++;
      continue;
    }
    permittedRels.push({
      ...r,
      isCrossDomain: src.domainKey !== tgt.domainKey,
      sourceName: src.name,
      sourceDomain: src.domainKey,
      targetName: tgt.name,
      targetDomain: tgt.domainKey,
    });
  }

  const entitiesPerDomain: Record<string, number> = {};
  for (const d of domains) entitiesPerDomain[d.key] = 0;
  for (const e of permittedEntities) {
    entitiesPerDomain[e.domainKey] = (entitiesPerDomain[e.domainKey] || 0) + 1;
  }

  // 2. Filter by domain subgraph (with optional cross-domain bridge nodes/edges!)
  const domainFilterSet = new Set<string>();
  if (params.domain && params.domain !== "ALL") {
    domainFilterSet.add(params.domain);
  }
  if (Array.isArray(params.domains)) {
    for (const d of params.domains) {
      if (d && d !== "ALL") domainFilterSet.add(d);
    }
  }

  const includeBridges = params.includeCrossDomainBridges !== false;
  let filteredEntities = permittedEntities;
  let filteredRels = permittedRels;

  if (domainFilterSet.size > 0) {
    if (includeBridges) {
      filteredRels = permittedRels.filter(
        (r) =>
          domainFilterSet.has(r.domainKey) ||
          domainFilterSet.has(r.sourceDomain) ||
          domainFilterSet.has(r.targetDomain)
      );
      const keepIds = new Set<number>(
        permittedEntities
          .filter((e) => domainFilterSet.has(e.domainKey))
          .map((e) => e.id)
      );
      for (const r of filteredRels) {
        keepIds.add(r.sourceEntityId);
        keepIds.add(r.targetEntityId);
      }
      filteredEntities = permittedEntities.filter((e) => keepIds.has(e.id));
    } else {
      // Pure isolated domain subgraph
      filteredEntities = permittedEntities.filter((e) =>
        domainFilterSet.has(e.domainKey)
      );
      const keepIds = new Set(filteredEntities.map((e) => e.id));
      filteredRels = permittedRels.filter(
        (r) => keepIds.has(r.sourceEntityId) && keepIds.has(r.targetEntityId)
      );
    }
  }

  if (params.onlyCrossDomain) {
    filteredRels = filteredRels.filter((r) => r.isCrossDomain);
    const keepIds = new Set<number>();
    for (const r of filteredRels) {
      keepIds.add(r.sourceEntityId);
      keepIds.add(r.targetEntityId);
    }
    filteredEntities = filteredEntities.filter((e) => keepIds.has(e.id));
  }

  // 3. Optional multi-hop BFS traversal across domains from seed query
  if (params.seedQuery && params.seedQuery.trim().length > 0) {
    const qTerms = tokenize(params.seedQuery);
    const qLower = params.seedQuery.toLowerCase();
    const maxHops = Math.min(3, Math.max(1, Number(params.hops) || 2));

    const seedIds = new Set<number>();
    for (const e of filteredEntities) {
      const hay = `${e.name} ${e.entityType} ${e.domainKey} ${e.description} ${Object.values(
        e.attributes || {}
      ).join(" ")}`.toLowerCase();
      if (
        hay.includes(qLower) ||
        qTerms.some((t) => t.length >= 3 && hay.includes(t))
      ) {
        seedIds.add(e.id);
      }
    }

    if (seedIds.size > 0) {
      const visited = new Set<number>(seedIds);
      let frontier = new Set<number>(seedIds);
      const traversedRelIds = new Set<number>();

      for (let hop = 0; hop < maxHops; hop++) {
        const nextFrontier = new Set<number>();
        for (const r of filteredRels) {
          if (frontier.has(r.sourceEntityId)) {
            traversedRelIds.add(r.id);
            if (!visited.has(r.targetEntityId)) {
              visited.add(r.targetEntityId);
              nextFrontier.add(r.targetEntityId);
            }
          }
          if (frontier.has(r.targetEntityId)) {
            traversedRelIds.add(r.id);
            if (!visited.has(r.sourceEntityId)) {
              visited.add(r.sourceEntityId);
              nextFrontier.add(r.sourceEntityId);
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.size === 0) break;
      }

      filteredEntities = filteredEntities.filter((e) => visited.has(e.id));
      filteredRels = filteredRels.filter((r) => traversedRelIds.has(r.id));
    }
  }

  return {
    domains,
    entities: filteredEntities,
    relationships: filteredRels,
    stats: {
      visibleEntities: filteredEntities.length,
      visibleRelationships: filteredRels.length,
      crossDomainRelationships: filteredRels.filter((r) => r.isCrossDomain)
        .length,
      aclRedactedEntities,
      aclRedactedRelationships,
      entitiesPerDomain,
    },
  };
}

export async function createGraphEntity(params: {
  name: string;
  entityType: string;
  domainKey: string;
  taxonomyConceptId?: string | null;
  description: string;
  attributes?: Record<string, string>;
  classificationLevel?: ClearanceLevel;
  aclReadRoles?: string[];
}): Promise<EkEntity> {
  await ensureEnterpriseKnowledgeInitialized();
  const key = `${slugifyKey(params.name)}-${Date.now().toString(36).slice(-3)}`;
  const acl =
    Array.isArray(params.aclReadRoles) && params.aclReadRoles.length > 0
      ? Array.from(new Set(["CEO", ...params.aclReadRoles]))
      : ["CEO", "CTO", "CFO", "COO"];
  const [created] = await db
    .insert(ekEntities)
    .values({
      canonicalKey: key,
      name: params.name.trim(),
      entityType: params.entityType.trim() || "Initiative",
      domainKey: params.domainKey,
      taxonomyConceptId: params.taxonomyConceptId || null,
      description: params.description.trim(),
      attributes: params.attributes || {},
      classificationLevel: normalizeClearance(params.classificationLevel),
      aclReadRoles: acl,
    })
    .returning();
  return created;
}

export async function createGraphRelationship(params: {
  sourceEntityId: number;
  targetEntityId: number;
  predicate: string;
  domainKey: string;
  evidence?: string;
  weight?: number;
  classificationLevel?: ClearanceLevel;
  aclReadRoles?: string[];
}): Promise<EkRelationship> {
  await ensureEnterpriseKnowledgeInitialized();
  const [src] = await db
    .select()
    .from(ekEntities)
    .where(eq(ekEntities.id, params.sourceEntityId))
    .limit(1);
  const [tgt] = await db
    .select()
    .from(ekEntities)
    .where(eq(ekEntities.id, params.targetEntityId))
    .limit(1);
  if (!src || !tgt) {
    throw new Error("Both sourceEntityId and targetEntityId must exist.");
  }

  const acl =
    Array.isArray(params.aclReadRoles) && params.aclReadRoles.length > 0
      ? Array.from(new Set(["CEO", ...params.aclReadRoles]))
      : ["CEO", "CTO", "CFO", "COO"];

  const [created] = await db
    .insert(ekRelationships)
    .values({
      sourceEntityId: src.id,
      targetEntityId: tgt.id,
      predicate: params.predicate
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_"),
      domainKey: params.domainKey || src.domainKey,
      isCrossDomain: src.domainKey !== tgt.domainKey,
      weight: Math.min(100, Math.max(10, Number(params.weight) || 88)),
      evidence: (params.evidence || "").trim(),
      classificationLevel: normalizeClearance(params.classificationLevel),
      aclReadRoles: acl,
    })
    .returning();
  return created;
}

// ============================================================================
// HYBRID RETRIEVAL (ACL + BM25 + 128d VECTOR + SKOS EXPANSION + GRAPHRAG)
// ============================================================================
export interface EnterpriseRetrievalPassage {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  docType: string;
  domainKey: string;
  heading: string;
  content: string;
  classificationLevel: string;
  reviewStatus: string;
  taxonomyConcepts: string[];
  scores: {
    combined: number;
    vector: number;
    lexical: number;
    taxonomyBoost: number;
  };
  matchedTerms: string[];
}

export async function retrieveEnterpriseKnowledge(params: {
  query: string;
  principal: AccessPrincipal;
  domains?: string[]; // empty = cross-domain across all authorized KBs
  topK?: number;
  includePendingReview?: boolean;
  includeGraph?: boolean;
  graphHops?: number;
  synthesizeAnswer?: boolean;
  includeSeparateAgentMemory?: boolean;
}) {
  await ensureEnterpriseKnowledgeInitialized();
  const query = params.query.trim();
  const topK = Math.min(12, Math.max(1, Number(params.topK) || 5));
  const includePending =
    params.includePendingReview ?? params.principal.role === "CEO";
  const includeGraph = params.includeGraph !== false;

  const [scheme, allDocs, allChunks] = await Promise.all([
    getActiveTaxonomyScheme(),
    db.select().from(ekDocuments),
    db.select().from(ekChunks),
  ]);

  // 1. Detect SKOS concepts in query & expand via altLabels + cross-domain skos:related!
  const queryClassified = classifyWithSkosScheme({
    title: query,
    content: query,
    concepts: scheme.parsedConcepts,
    maxTags: 3,
  });
  const matchedConceptIds = new Set(queryClassified.tags.map((t) => t.conceptId));
  const relatedConceptIds = new Set<string>();
  const expandedTerms: string[] = [];

  for (const tag of queryClassified.tags) {
    const c = scheme.parsedConcepts.find((x) => x.id === tag.conceptId);
    if (!c) continue;
    expandedTerms.push(...c.altLabels.slice(0, 3));
    for (const relId of c.related) {
      relatedConceptIds.add(relId);
      const rc = scheme.parsedConcepts.find((x) => x.id === relId);
      if (rc) expandedTerms.push(rc.prefLabel, ...rc.altLabels.slice(0, 2));
    }
  }

  // 2. ACL & Domain & Review Status Pre-Filtering
  const requestedDomains =
    Array.isArray(params.domains) &&
    params.domains.filter((d) => d && d !== "ALL").length > 0
      ? new Set(params.domains.filter((d) => d && d !== "ALL"))
      : null;

  let aclRedactedDocuments = 0;
  const redactedTitlesHint: Array<{ domainKey: string; classificationLevel: string }> =
    [];
  const authorizedDocMap = new Map<number, EkDocument>();

  for (const doc of allDocs) {
    if (
      requestedDomains &&
      !requestedDomains.has(doc.domainKey) &&
      !(doc.secondaryDomains || []).some((sd) => requestedDomains.has(sd))
    ) {
      continue;
    }
    if (!canPrincipalRead(params.principal, doc)) {
      aclRedactedDocuments++;
      redactedTitlesHint.push({
        domainKey: doc.domainKey,
        classificationLevel: doc.classificationLevel,
      });
      continue;
    }
    if (doc.reviewStatus === "rejected") continue;
    if (doc.reviewStatus === "pending_review" && !includePending) continue;
    authorizedDocMap.set(doc.id, doc);
  }

  // 3. Hybrid Vector + BM25 + SKOS Taxonomy Scoring over Authorized Chunks
  const qVec = computeSemanticEmbedding(query);
  const qTokens = tokenize(query);

  const scoredPassages: EnterpriseRetrievalPassage[] = [];
  for (const ch of allChunks) {
    const doc = authorizedDocMap.get(ch.documentId);
    if (!doc) continue;

    const vecScore = cosineSimilarity(qVec, ch.embedding || []);
    const lex = lexicalBm25Score(
      qTokens,
      `${doc.title} ${ch.heading} ${ch.content}`,
      expandedTerms
    );

    const docConceptIds = (doc.taxonomyConcepts || []).map((t) => t.conceptId);
    let taxBoost = 0;
    for (const cid of docConceptIds) {
      if (matchedConceptIds.has(cid)) taxBoost += 0.14;
      else if (relatedConceptIds.has(cid)) taxBoost += 0.08;
    }
    taxBoost = Math.min(0.26, taxBoost);

    const approvalBoost = doc.reviewStatus === "approved" ? 0.03 : 0;
    const combined = Math.min(
      0.99,
      lex.score * 0.52 + vecScore * 0.34 + taxBoost + approvalBoost
    );

    if (combined >= 0.08 || scoredPassages.length < 2) {
      scoredPassages.push({
        chunkId: ch.id,
        documentId: doc.id,
        documentTitle: doc.title,
        docType: doc.docType,
        domainKey: doc.domainKey,
        heading: ch.heading,
        content: ch.content,
        classificationLevel: doc.classificationLevel,
        reviewStatus: doc.reviewStatus,
        taxonomyConcepts: docConceptIds,
        scores: {
          combined: Math.round(combined * 1000) / 1000,
          vector: Math.round(vecScore * 1000) / 1000,
          lexical: Math.round(lex.score * 1000) / 1000,
          taxonomyBoost: Math.round(taxBoost * 1000) / 1000,
        },
        matchedTerms: lex.matchedTerms,
      });
    }
  }

  scoredPassages.sort((a, b) => b.scores.combined - a.scores.combined);
  const topPassages = scoredPassages.slice(0, topK);

  // 4. Cross-Domain Multi-Hop Knowledge Graph Traversal
  let graphContext: {
    entities: Array<{
      id: number;
      name: string;
      entityType: string;
      domainKey: string;
      classificationLevel: string;
      description: string;
      attributes: Record<string, string>;
    }>;
    triples: Array<{
      id: number;
      subject: string;
      subjectDomain: string;
      predicate: string;
      object: string;
      objectDomain: string;
      edgeDomain: string;
      isCrossDomain: boolean;
      evidence: string;
    }>;
    aclRedactedEntities: number;
  } = { entities: [], triples: [], aclRedactedEntities: 0 };

  if (includeGraph) {
    const kg = await queryKnowledgeGraph({
      principal: params.principal,
      domains: requestedDomains ? Array.from(requestedDomains) : undefined,
      includeCrossDomainBridges: true,
      seedQuery: query,
      hops: params.graphHops ?? 2,
    });

    graphContext = {
      entities: kg.entities.slice(0, 10).map((e) => ({
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        domainKey: e.domainKey,
        classificationLevel: e.classificationLevel,
        description: e.description,
        attributes: e.attributes || {},
      })),
      triples: kg.relationships.slice(0, 12).map((r) => ({
        id: r.id,
        subject: r.sourceName,
        subjectDomain: r.sourceDomain,
        predicate: r.predicate,
        object: r.targetName,
        objectDomain: r.targetDomain,
        edgeDomain: r.domainKey,
        isCrossDomain: r.isCrossDomain,
        evidence: r.evidence,
      })),
      aclRedactedEntities: kg.stats.aclRedactedEntities,
    };
  }

  const domainsTraversed = Array.from(
    new Set([
      ...topPassages.map((p) => p.domainKey),
      ...graphContext.entities.map((e) => e.domainKey),
    ])
  );

  // 5. Grounded Cross-Domain Answer Synthesis (purely from authorized Enterprise KB + KG!)
  let synthesizedAnswer: string | null = null;
  let answerMode: "opencode-live" | "grounded-hybrid-synthesis" =
    "grounded-hybrid-synthesis";

  if (params.synthesizeAnswer !== false) {
    const config = await getActiveOpencodeConfig();
    const passageContext = topPassages
      .slice(0, 4)
      .map(
        (p) =>
          `[Doc #${p.documentId} | ${p.domainKey} | ${p.classificationLevel}] ${p.documentTitle} (${p.heading}): ${p.content}`
      )
      .join("\n");
    const tripleContext = graphContext.triples
      .slice(0, 8)
      .map(
        (t) =>
          `- (${t.subject} [${t.subjectDomain}]) --${t.predicate} [${t.edgeDomain}]--> (${t.object} [${t.objectDomain}]): ${t.evidence}`
      )
      .join("\n");

    const live = await tryLiveOpencodeCompletion({
      config,
      modelDisplayId: config.ctoModel,
      maxTokens: 420,
      systemPrompt: `You are the Aether Enterprise Knowledge Retrieval Engine answering for principal role "${params.principal.role}" (clearance: ${params.principal.clearance}).
Answer strictly using the authorized enterprise passages and cross-domain knowledge graph triples below. Cite [Doc #ID] inline and highlight cross-domain dependencies. Keep to 3-5 crisp executive sentences.`,
      userPrompt: `QUERY: ${query}\n\nAUTHORIZED PASSAGES:\n${passageContext || "None"}\n\nKNOWLEDGE GRAPH TRIPLES:\n${tripleContext || "None"}`,
    });

    if (live) {
      synthesizedAnswer = live;
      answerMode = "opencode-live";
    } else {
      synthesizedAnswer = buildGroundedSynthesis({
        principal: params.principal,
        topPassages,
        triples: graphContext.triples,
        domainsTraversed,
        aclRedactedDocuments,
      });
    }
  }

  // 6. Optional STRICTLY SEPARATED Agent Memory Envelope (only if explicitly requested AND permitted!)
  let isolatedAgentMemory: {
    plane: "conversational_agent_memory";
    permitted: boolean;
    reason?: string;
    personaVersion?: number;
    styleHint?: string;
    recentMemories?: Array<{ role: string; type: string; content: string }>;
  } | null = null;

  if (params.includeSeparateAgentMemory) {
    if (!params.principal.canReadAgentMemory) {
      isolatedAgentMemory = {
        plane: "conversational_agent_memory",
        permitted: false,
        reason: `Caller role "${params.principal.role}" does not hold canReadAgentMemory permission. Conversational agent memory remains isolated.`,
      };
    } else {
      const [[persona], mems] = await Promise.all([
        db.select().from(ceoPersona).orderBy(asc(ceoPersona.id)).limit(1),
        db
          .select()
          .from(executiveMemories)
          .orderBy(desc(executiveMemories.id))
          .limit(4),
      ]);
      isolatedAgentMemory = {
        plane: "conversational_agent_memory",
        permitted: true,
        personaVersion: persona?.version ?? 0,
        styleHint: persona?.profile?.styleHint || "",
        recentMemories: mems.map((m) => ({
          role: m.executiveRole,
          type: m.memoryType,
          content: m.content.slice(0, 180),
        })),
      };
    }
  }

  return {
    plane: "enterprise_knowledge" as const,
    agentMemoryIsolated: true,
    principal: {
      role: params.principal.role,
      authType: params.principal.authType,
      clearance: params.principal.clearance,
      allowedDomains: params.principal.allowedDomains,
      keyName: params.principal.keyName || null,
    },
    query,
    skosExpansion: {
      matchedConcepts: queryClassified.tags.map((t) => ({
        conceptId: t.conceptId,
        prefLabel: t.prefLabel,
        domainKey: t.domainKey,
        confidence: t.confidence,
      })),
      relatedCrossDomainConcepts: Array.from(relatedConceptIds),
    },
    aclAudit: {
      authorizedDocumentsSearched: authorizedDocMap.size,
      redactedDocuments: aclRedactedDocuments,
      redactedBreakdown: redactedTitlesHint,
      redactedGraphEntities: graphContext.aclRedactedEntities,
    },
    domainsTraversed,
    crossDomainEdgesUsed: graphContext.triples.filter((t) => t.isCrossDomain)
      .length,
    answer: synthesizedAnswer,
    answerMode,
    passages: topPassages,
    knowledgeGraph: graphContext,
    ...(isolatedAgentMemory ? { isolatedAgentMemory } : {}),
  };
}

function buildGroundedSynthesis(params: {
  principal: AccessPrincipal;
  topPassages: EnterpriseRetrievalPassage[];
  triples: Array<{
    subject: string;
    subjectDomain: string;
    predicate: string;
    object: string;
    objectDomain: string;
    isCrossDomain: boolean;
    evidence: string;
  }>;
  domainsTraversed: string[];
  aclRedactedDocuments: number;
}): string {
  const {
    principal,
    topPassages,
    triples,
    domainsTraversed,
    aclRedactedDocuments,
  } = params;

  if (topPassages.length === 0 && triples.length === 0) {
    return aclRedactedDocuments > 0
      ? `No authorized enterprise documents matched for role ${principal.role} (clearance: ${principal.clearance}). ${aclRedactedDocuments} restricted document(s) were withheld by Enterprise ACL policy.`
      : `No matching enterprise knowledge records found within the authorized scope for ${principal.role}.`;
  }

  const parts: string[] = [];
  for (const p of topPassages.slice(0, 2)) {
    const firstSentence =
      p.content.split(/(?<=[.!?])\s+/)[0] || p.content.slice(0, 180);
    parts.push(
      `[Doc #${p.documentId} · ${p.domainKey}] ${firstSentence}`
    );
  }

  const crossTriples = triples.filter((t) => t.isCrossDomain).slice(0, 2);
  if (crossTriples.length > 0) {
    const chain = crossTriples
      .map(
        (t) =>
          `${t.subject} (${t.subjectDomain}) → ${t.predicate} → ${t.object} (${t.objectDomain})`
      )
      .join("; ");
    parts.push(
      `Cross-domain Knowledge Graph trace across ${domainsTraversed.join(
        ", "
      )}: ${chain}.`
    );
  }

  if (aclRedactedDocuments > 0) {
    parts.push(
      `ACL Notice: ${aclRedactedDocuments} higher-clearance document(s) were filtered out for principal role ${principal.role} (${principal.clearance}).`
    );
  }

  return parts.join(" ");
}

// ============================================================================
// MERMAID MINDMAP SUMMARY VISUALIZER GENERATOR
// ============================================================================
function safeMermaidLabel(raw: string, maxLen = 44): string {
  // Remove characters that carry structural meaning in Mermaid mindmap syntax
  const cleaned = raw
    .replace(/[()[\]{}"'`<>:#;|\\*!@]/g, " ")
    .replace(/&/g, "and")
    .replace(/^\s*[-+]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Item";
  if (cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 14 ? slice.slice(0, lastSpace) : slice).trim();
}

export async function generateEnterpriseMindmap(params: {
  principal: AccessPrincipal;
  domainFilter?: string | null;
  includeCrossDomain?: boolean;
}): Promise<{
  mermaidCode: string;
  summary: {
    principalRole: PrincipalRole;
    clearance: ClearanceLevel;
    domainsCount: number;
    conceptsCount: number;
    approvedDocsCount: number;
    pendingDocsCount: number;
    entitiesCount: number;
    relationshipsCount: number;
    crossDomainEdgesCount: number;
    redactedDocsCount: number;
    redactedEntitiesCount: number;
    agentMemorySeparation: {
      enterpriseDocs: number;
      enterpriseEntities: number;
      enterpriseEdges: number;
      conversationalMessages: number;
      agentMemories: number;
      sessionInsights: number;
      personaVersion: number;
    };
  };
}> {
  await ensureEnterpriseKnowledgeInitialized();
  const [
    domains,
    scheme,
    allDocs,
    kg,
    [{ msgCount }],
    [{ memCount }],
    [{ noteCount }],
    personaRows,
  ] = await Promise.all([
    db.select().from(ekDomains).orderBy(asc(ekDomains.id)),
    getActiveTaxonomyScheme(),
    db.select().from(ekDocuments).orderBy(asc(ekDocuments.id)),
    queryKnowledgeGraph({
      principal: params.principal,
      domain: params.domainFilter || "ALL",
      includeCrossDomainBridges: params.includeCrossDomain !== false,
    }),
    db
      .select({ msgCount: sql<number>`count(*)::int` })
      .from(conversationMessages),
    db
      .select({ memCount: sql<number>`count(*)::int` })
      .from(executiveMemories),
    db
      .select({ noteCount: sql<number>`count(*)::int` })
      .from(knowledgeEntries),
    db.select().from(ceoPersona).orderBy(asc(ceoPersona.id)).limit(1),
  ]);

  const activeDomains =
    params.domainFilter && params.domainFilter !== "ALL"
      ? domains.filter((d) => d.key === params.domainFilter)
      : domains.filter(
          (d) =>
            params.principal.allowedDomains.includes("*") ||
            params.principal.allowedDomains.includes(d.key)
        );

  const visibleDocs = allDocs.filter(
    (d) =>
      canPrincipalRead(params.principal, d) &&
      d.reviewStatus !== "rejected" &&
      (!params.domainFilter ||
        params.domainFilter === "ALL" ||
        d.domainKey === params.domainFilter)
  );
  const redactedDocsCount = allDocs.filter(
    (d) => !canPrincipalRead(params.principal, d)
  ).length;

  const lines: string[] = [
    "mindmap",
    `  root((Aether Enterprise Knowledge OS))`,
  ];

  for (const dom of activeDomains) {
    const domConcepts = scheme.parsedConcepts.filter(
      (c) => c.domainKey === dom.key
    );
    const domDocs = visibleDocs.filter((d) => d.domainKey === dom.key);
    const domEntities = kg.entities.filter((e) => e.domainKey === dom.key);

    lines.push(
      `    ${safeMermaidLabel(`${dom.name} - ${dom.ownerRole}`, 40)}`
    );

    if (domConcepts.length > 0) {
      lines.push(`      SKOS Taxonomy ${domConcepts.length}`);
      for (const c of domConcepts.slice(0, 3)) {
        lines.push(`        ${safeMermaidLabel(c.prefLabel, 34)}`);
      }
    }

    if (domDocs.length > 0) {
      lines.push(`      KB Docs ${domDocs.length}`);
      for (const doc of domDocs.slice(0, 3)) {
        const badge =
          doc.reviewStatus === "pending_review"
            ? "Review "
            : doc.classificationLevel === "board_restricted"
            ? "Board "
            : "";
        const shortTitle = doc.title.replace(/^[A-Z]+-\d+:\s*/i, "");
        lines.push(`        ${safeMermaidLabel(`${badge}${shortTitle}`, 34)}`);
      }
    }

    if (domEntities.length > 0) {
      lines.push(`      KG Entities ${domEntities.length}`);
      for (const ent of domEntities.slice(0, 3)) {
        lines.push(`        ${safeMermaidLabel(ent.name, 34)}`);
      }
    }
  }

  const crossEdges = kg.relationships.filter((r) => r.isCrossDomain);
  if (params.includeCrossDomain !== false && crossEdges.length > 0) {
    lines.push(`    Cross-Domain Bridges ${crossEdges.length}`);
    for (const edge of crossEdges.slice(0, 5)) {
      const predShort = edge.predicate.toLowerCase().replace(/_/g, " ");
      lines.push(
        `      ${safeMermaidLabel(
          `${edge.sourceName.split(" ").slice(0, 2).join(" ")} ${predShort} ${edge.targetName
            .split(" ")
            .slice(0, 2)
            .join(" ")}`,
          42
        )}`
      );
    }
  }

  lines.push(`    Governance and Isolation`);
  lines.push(
    `      ACL Role ${safeMermaidLabel(
      `${params.principal.role} ${params.principal.clearance}`,
      34
    )}`
  );
  lines.push(`      Taxonomy YAML SKOS v${scheme.version}`);
  lines.push(`      Agent Memory Strictly Isolated`);

  return {
    mermaidCode: lines.join("\n"),
    summary: {
      principalRole: params.principal.role,
      clearance: params.principal.clearance,
      domainsCount: activeDomains.length,
      conceptsCount: scheme.parsedConcepts.length,
      approvedDocsCount: visibleDocs.filter((d) => d.reviewStatus === "approved")
        .length,
      pendingDocsCount: visibleDocs.filter(
        (d) => d.reviewStatus === "pending_review"
      ).length,
      entitiesCount: kg.stats.visibleEntities,
      relationshipsCount: kg.stats.visibleRelationships,
      crossDomainEdgesCount: kg.stats.crossDomainRelationships,
      redactedDocsCount,
      redactedEntitiesCount: kg.stats.aclRedactedEntities,
      agentMemorySeparation: {
        enterpriseDocs: allDocs.length,
        enterpriseEntities:
          kg.stats.visibleEntities + kg.stats.aclRedactedEntities,
        enterpriseEdges:
          kg.stats.visibleRelationships + kg.stats.aclRedactedRelationships,
        conversationalMessages: msgCount || 0,
        agentMemories: memCount || 0,
        sessionInsights: noteCount || 0,
        personaVersion: personaRows[0]?.version || 0,
      },
    },
  };
}

// ============================================================================
// SCOPED REST API KEYS FOR EXTERNAL AI MODELS / TOOLS
// ============================================================================
export async function createEnterpriseApiKey(params: {
  name: string;
  assignedRole: PrincipalRole;
  allowedDomains?: string[];
  clearanceLevel?: ClearanceLevel;
  canWrite?: boolean;
  canReadAgentMemory?: boolean;
}): Promise<{
  plainTextKey: string;
  record: Omit<typeof ekApiKeys.$inferSelect, "keyHash">;
}> {
  await ensureEnterpriseKnowledgeInitialized();
  const secret = crypto.randomBytes(22).toString("base64url");
  const plainTextKey = `aek_${secret}`;
  const keyPrefix = `${plainTextKey.slice(0, 10)}…${plainTextKey.slice(-4)}`;
  const keyHash = crypto
    .createHash("sha256")
    .update(plainTextKey)
    .digest("hex");

  const role = VALID_ROLES.has(params.assignedRole)
    ? params.assignedRole
    : "EXTERNAL_AGENT";
  const clearance = normalizeClearance(
    params.clearanceLevel || DEFAULT_ROLE_CLEARANCE[role]
  );
  const domains =
    Array.isArray(params.allowedDomains) && params.allowedDomains.length > 0
      ? params.allowedDomains
      : ["*"];

  const [saved] = await db
    .insert(ekApiKeys)
    .values({
      name: params.name.trim(),
      keyPrefix,
      keyHash,
      assignedRole: role,
      allowedDomains: domains,
      clearanceLevel: clearance,
      canWrite: Boolean(params.canWrite),
      canReadAgentMemory: Boolean(params.canReadAgentMemory),
    })
    .returning();

  const { keyHash: _unused, ...safeRecord } = saved;
  void _unused;
  return { plainTextKey, record: safeRecord };
}

export async function listEnterpriseApiKeys() {
  await ensureEnterpriseKnowledgeInitialized();
  const rows = await db
    .select()
    .from(ekApiKeys)
    .orderBy(desc(ekApiKeys.id));
  return rows.map(({ keyHash: _unused, ...rest }) => {
    void _unused;
    return rest;
  });
}

export async function revokeEnterpriseApiKey(id: number): Promise<void> {
  await ensureEnterpriseKnowledgeInitialized();
  await db
    .update(ekApiKeys)
    .set({ revoked: true })
    .where(eq(ekApiKeys.id, id));
}
