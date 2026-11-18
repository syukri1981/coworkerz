import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const deliberationSessions = pgTable("deliberation_sessions", {
  id: serial("id").primaryKey(),
  ceoQuestion: text("ceo_question").notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'deliberating' | 'completed'
  autoWalkAndTalk: boolean("auto_walk_and_talk").notNull().default(true),
  turnCount: integer("turn_count").notNull().default(0),
  executiveSummary: text("executive_summary"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => deliberationSessions.id, { onDelete: "cascade" }),
  senderRole: text("sender_role").notNull(), // 'CEO' | 'CTO' | 'CFO' | 'COO'
  targetRole: text("target_role").notNull().default("ALL"), // 'ALL' | 'CEO' | 'CTO' | 'CFO' | 'COO'
  interactionMode: text("interaction_mode").notNull().default("walk_and_talk"), // 'ceo_directive' | 'walk_and_talk' | 'executive_consensus'
  roomZone: text("room_zone").notNull().default("strategy-table"), // 'ceo-briefing' | 'strategy-table' | 'tech-wall' | 'finance-desk' | 'window-lounge'
  content: text("content").notNull(),
  modelUsed: text("model_used").notNull().default("opencode/deepseek-v4.1-flash-free"),
  providerMode: text("provider_mode").notNull().default("opencode-live"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const knowledgeEntries = pgTable("knowledge_entries", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => deliberationSessions.id, {
    onDelete: "set null",
  }),
  sourceMessageId: integer("source_message_id").references(
    () => conversationMessages.id,
    { onDelete: "set null" }
  ),
  contributorRole: text("contributor_role").notNull(), // 'CTO' | 'CFO' | 'COO' | 'JOINT'
  collaboratorRole: text("collaborator_role"), // 'CTO' | 'CFO' | 'COO' | 'ALL'
  topic: text("topic").notNull(),
  insight: text("insight").notNull(),
  category: text("category").notNull().default("cross-functional"), // 'architecture' | 'finance' | 'operations' | 'cross-functional'
  confidenceScore: integer("confidence_score").notNull().default(91),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  appliedCount: integer("applied_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const opencodeConfigs = pgTable("opencode_configs", {
  id: serial("id").primaryKey(),
  baseUrl: text("base_url")
    .notNull()
    .default("https://opencode.ai/inference/openai/v1"),
  apiKey: text("api_key").notNull().default(""),
  ctoModel: text("cto_model")
    .notNull()
    .default("opencode/deepseek-v4.1-flash-free"),
  cfoModel: text("cfo_model")
    .notNull()
    .default("opencode/mimo-v2.6-flash-free"),
  cooModel: text("coo_model")
    .notNull()
    .default("opencode/nemotron-3.5-lightning-free"),
  temperature: text("temperature").notNull().default("0.65"),
  walkTalkRounds: integer("walk_talk_rounds").notNull().default(4),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export interface CeoPersonaProfile {
  executiveSummary: string;
  skills: Array<{
    name: string;
    score: number;
    evidenceCount: number;
    lastEvidence: string;
  }>;
  decisionStyle: string[];
  communicationStyle: {
    label: string;
    avgWords: number;
    questionRatio: number;
    quantitativeRatio: number;
    notes: string[];
  };
  styleHint: string;
  strategicPriorities: Array<{ theme: string; mentions: number }>;
  recurringThemes: string[];
  executiveObservations: Record<"CTO" | "CFO" | "COO", string[]>;
  recentDirectives: Array<{
    sessionId: number;
    content: string;
    targetRole: string;
    createdAt: string;
  }>;
  stats: {
    totalCeoMessages: number;
    totalSessions: number;
    totalBotMessages: number;
    botToBotExchanges: number;
    directFollowUps: number;
    consensusBriefings: number;
    knowledgeEntries: number;
  };
  aiRefined?: boolean;
}

// Single living "main file" describing the CEO's skills & persona (mirrored to memory/CEO_PERSONA.md)
export const ceoPersona = pgTable("ceo_persona", {
  id: serial("id").primaryKey(),
  displayName: text("display_name").notNull().default("CEO"),
  version: integer("version").notNull().default(0),
  markdown: text("markdown").notNull().default(""),
  profile: jsonb("profile").$type<CeoPersonaProfile>(),
  analyzedMessageCount: integer("analyzed_message_count").notNull().default(0),
  providerMode: text("provider_mode")
    .notNull()
    .default("opencode-local-runtime"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const personaRevisions = pgTable("persona_revisions", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull(),
  changeSummary: text("change_summary").notNull(),
  triggerEvent: text("trigger_event").notNull(), // 'initial' | 'ceo_directive' | 'ceo_followup' | 'ceo_response' | 'consensus' | 'manual_rebuild'
  sessionId: integer("session_id").references(() => deliberationSessions.id, {
    onDelete: "set null",
  }),
  markdown: text("markdown").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Long-term per-executive memory: every message each bot said, heard or observed (survives session deletion)
export const executiveMemories = pgTable("executive_memories", {
  id: serial("id").primaryKey(),
  executiveRole: text("executive_role").notNull(), // 'CTO' | 'CFO' | 'COO'
  sessionId: integer("session_id").references(() => deliberationSessions.id, {
    onDelete: "set null",
  }),
  sessionQuestion: text("session_question"),
  sourceMessageId: integer("source_message_id").references(
    () => conversationMessages.id,
    { onDelete: "set null" }
  ),
  memoryType: text("memory_type").notNull(), // 'ceo-directive' | 'ceo-followup' | 'said' | 'heard' | 'observed' | 'learned'
  counterpartRole: text("counterpart_role"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================================
// ENTERPRISE AI KNOWLEDGE LAYER (ek_*)
// Strictly isolated from conversational agent memory (conversation_messages,
// executive_memories, ceo_persona, knowledge_entries).
// ============================================================================

export type ClearanceLevel =
  | "public"
  | "internal"
  | "confidential"
  | "board_restricted";

export type PrincipalRole =
  | "CEO"
  | "CTO"
  | "CFO"
  | "COO"
  | "EXTERNAL_AGENT";

export interface SkosConcept {
  id: string; // e.g. "tech:sovereign-ai-infra"
  uri: string; // e.g. "urn:aether:skos:tech:sovereign-ai-infra"
  prefLabel: string;
  altLabels: string[];
  definition: string;
  domainKey: string;
  broader: string | null; // parent concept ID
  related: string[]; // cross-domain or intra-domain concept IDs
}

export interface DocumentClassificationTag {
  conceptId: string;
  prefLabel: string;
  domainKey: string;
  uri: string;
  confidence: number; // 0-100
  matchedSignals: string[];
  origin: "llm-zero-shot" | "skos-classifier" | "human-reviewer";
}

export interface EnterpriseDocMetadata {
  author?: string;
  version?: string;
  effectiveDate?: string;
  region?: string;
  sourceSystem?: string;
  promotedFromNoteId?: number | null;
  tags?: string[];
}

export const ekDomains = pgTable("ek_domains", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // 'technology' | 'finance' | 'operations' | 'governance' | 'corporate_strategy'
  name: text("name").notNull(),
  description: text("description").notNull(),
  ownerRole: text("owner_role").notNull().default("CEO"),
  colorHex: text("color_hex").notNull().default("#2563EB"),
  defaultClearance: text("default_clearance").notNull().default("internal"),
  aclReadRoles: jsonb("acl_read_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO", "CTO", "CFO", "COO"]),
  aclWriteRoles: jsonb("acl_write_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO"]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ekTaxonomySchemes = pgTable("ek_taxonomy_schemes", {
  id: serial("id").primaryKey(),
  schemeUri: text("scheme_uri")
    .notNull()
    .default("urn:aether:enterprise:taxonomy"),
  title: text("title")
    .notNull()
    .default("Aether Enterprise SKOS/OWL Knowledge Taxonomy"),
  version: integer("version").notNull().default(1),
  format: text("format").notNull().default("yaml-skos"),
  yamlContent: text("yaml_content").notNull(),
  skosTurtle: text("skos_turtle").notNull().default(""),
  parsedConcepts: jsonb("parsed_concepts")
    .$type<SkosConcept[]>()
    .notNull()
    .default([]),
  updatedBy: text("updated_by").notNull().default("CEO"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const ekDocuments = pgTable("ek_documents", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  docType: text("doc_type").notNull().default("policy"), // 'policy' | 'architecture_rfc' | 'financial_model' | 'runbook' | 'board_memo' | 'regulatory_filing'
  domainKey: text("domain_key")
    .notNull()
    .references(() => ekDomains.key, { onDelete: "restrict" }),
  secondaryDomains: jsonb("secondary_domains")
    .$type<string[]>()
    .notNull()
    .default([]),
  summary: text("summary").notNull(),
  content: text("content").notNull(),
  classificationLevel: text("classification_level")
    .notNull()
    .default("internal"), // ClearanceLevel
  aclReadRoles: jsonb("acl_read_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO", "CTO", "CFO", "COO"]),
  aclWriteRoles: jsonb("acl_write_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO"]),
  metadata: jsonb("metadata")
    .$type<EnterpriseDocMetadata>()
    .notNull()
    .default({}),
  taxonomyConcepts: jsonb("taxonomy_concepts")
    .$type<DocumentClassificationTag[]>()
    .notNull()
    .default([]),
  classifierMode: text("classifier_mode")
    .notNull()
    .default("skos-hybrid-classifier"), // 'opencode-zero-shot' | 'skos-hybrid-classifier' | 'human-curated'
  reviewStatus: text("review_status").notNull().default("pending_review"), // 'pending_review' | 'approved' | 'rejected'
  reviewedBy: text("reviewed_by"),
  reviewerNotes: text("reviewer_notes"),
  reviewedAt: timestamp("reviewed_at"),
  embedding: jsonb("embedding").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const ekChunks = pgTable("ek_chunks", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id")
    .notNull()
    .references(() => ekDocuments.id, { onDelete: "cascade" }),
  domainKey: text("domain_key").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  heading: text("heading").notNull().default("Section"),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull().default(0),
  embedding: jsonb("embedding").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ekEntities = pgTable("ek_entities", {
  id: serial("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull().default("System"), // 'System' | 'Initiative' | 'Metric' | 'Regulation' | 'Organization' | 'Region' | 'Team' | 'FinancialInstrument' | 'Product'
  domainKey: text("domain_key")
    .notNull()
    .references(() => ekDomains.key, { onDelete: "restrict" }),
  taxonomyConceptId: text("taxonomy_concept_id"),
  description: text("description").notNull(),
  attributes: jsonb("attributes")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  classificationLevel: text("classification_level")
    .notNull()
    .default("internal"),
  aclReadRoles: jsonb("acl_read_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO", "CTO", "CFO", "COO"]),
  sourceDocumentId: integer("source_document_id").references(
    () => ekDocuments.id,
    { onDelete: "set null" }
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ekRelationships = pgTable("ek_relationships", {
  id: serial("id").primaryKey(),
  sourceEntityId: integer("source_entity_id")
    .notNull()
    .references(() => ekEntities.id, { onDelete: "cascade" }),
  targetEntityId: integer("target_entity_id")
    .notNull()
    .references(() => ekEntities.id, { onDelete: "cascade" }),
  predicate: text("predicate").notNull(), // e.g. 'FUNDED_BY' | 'SATISFIES_REGULATION' | 'OPERATED_BY' | 'UNLOCKS_REVENUE' | 'GATED_BY_METRIC' | 'DEPENDS_ON' | 'MITIGATES_RISK' | 'TARGETS_ACQUISITION'
  domainKey: text("domain_key")
    .notNull()
    .references(() => ekDomains.key, { onDelete: "restrict" }),
  isCrossDomain: boolean("is_cross_domain").notNull().default(false),
  weight: integer("weight").notNull().default(85),
  evidence: text("evidence").notNull().default(""),
  classificationLevel: text("classification_level")
    .notNull()
    .default("internal"),
  aclReadRoles: jsonb("acl_read_roles")
    .$type<string[]>()
    .notNull()
    .default(["CEO", "CTO", "CFO", "COO"]),
  sourceDocumentId: integer("source_document_id").references(
    () => ekDocuments.id,
    { onDelete: "set null" }
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ekApiKeys = pgTable("ek_api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  assignedRole: text("assigned_role").notNull().default("EXTERNAL_AGENT"), // PrincipalRole
  allowedDomains: jsonb("allowed_domains")
    .$type<string[]>()
    .notNull()
    .default(["*"]),
  clearanceLevel: text("clearance_level").notNull().default("internal"), // ClearanceLevel
  canWrite: boolean("can_write").notNull().default(false),
  canReadAgentMemory: boolean("can_read_agent_memory").notNull().default(false),
  requestCount: integer("request_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at"),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EkDomain = typeof ekDomains.$inferSelect;
export type EkTaxonomyScheme = typeof ekTaxonomySchemes.$inferSelect;
export type EkDocument = typeof ekDocuments.$inferSelect;
export type EkChunk = typeof ekChunks.$inferSelect;
export type EkEntity = typeof ekEntities.$inferSelect;
export type EkRelationship = typeof ekRelationships.$inferSelect;
export type EkApiKey = typeof ekApiKeys.$inferSelect;

export type CeoPersona = typeof ceoPersona.$inferSelect;
export type PersonaRevision = typeof personaRevisions.$inferSelect;
export type ExecutiveMemory = typeof executiveMemories.$inferSelect;
export type DeliberationSession = typeof deliberationSessions.$inferSelect;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type OpencodeConfig = typeof opencodeConfigs.$inferSelect;
