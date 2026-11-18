import { load as loadYaml } from "js-yaml";
import type {
  DocumentClassificationTag,
  OpencodeConfig,
  SkosConcept,
} from "@/db/schema";
import { parseStructuredJson, tryLiveOpencodeCompletion } from "./opencode";

export const VALID_DOMAIN_KEYS = [
  "technology",
  "finance",
  "operations",
  "governance",
  "corporate_strategy",
] as const;

export type EnterpriseDomainKey = (typeof VALID_DOMAIN_KEYS)[number];

export const DEFAULT_ENTERPRISE_TAXONOMY_YAML = `# Aether Enterprise Knowledge Taxonomy (SKOS / OWL-Aligned YAML Scheme)
# Maintained by the Office of the CEO. Every ingested document is auto-classified
# against these concepts and queued for human-in-the-loop approval.
scheme:
  uri: "urn:aether:enterprise:taxonomy"
  title: "Aether Enterprise SKOS/OWL Knowledge Taxonomy"
  namespace: "urn:aether:skos:"
  owlOntology: "urn:aether:owl:EnterpriseKnowledgeGraph"

domains:
  technology:
    label: "AI & Cloud Architecture"
    owner: "CTO"
  finance:
    label: "Corporate Finance & Capital"
    owner: "CFO"
  operations:
    label: "Global Operations & Delivery"
    owner: "COO"
  governance:
    label: "Legal, Risk & Regulatory"
    owner: "CEO"
  corporate_strategy:
    label: "Board Strategy, M&A & Pricing"
    owner: "CEO"

objectProperties:
  - FUNDED_BY
  - GATED_BY_METRIC
  - SATISFIES_REGULATION
  - OPERATED_BY
  - UNLOCKS_REVENUE
  - DEPENDS_ON
  - MITIGATES_RISK
  - TARGETS_ACQUISITION
  - GOVERNED_BY_POLICY
  - INTEGRATES_WITH

concepts:
  # --- TECHNOLOGY DOMAIN (CTO) ---
  - id: "tech:ai-platform"
    domain: "technology"
    prefLabel: "Enterprise AI Platform"
    altLabels: ["llm runtime", "agent runtime", "model gateway", "opencode", "inference engine"]
    definition: "Core enterprise AI platform, model routing control planes, and autonomous agent services."
    broader: null
    related: ["strat:agentic-pricing", "gov:ai-safety-governance"]

  - id: "tech:sovereign-ai-infra"
    domain: "technology"
    prefLabel: "Sovereign AI Infrastructure"
    altLabels: ["sovereign cluster", "frankfurt gpu", "bare-metal gpu", "eu inference nodes", "quantized racks"]
    definition: "Dedicated regionally resident GPU inference clusters serving regulated sovereign workloads."
    broader: "tech:ai-platform"
    related: ["gov:eu-data-residency", "fin:capex-tranche-governance", "ops:emea-delivery-pods"]

  - id: "tech:multicloud-elasticity"
    domain: "technology"
    prefLabel: "Multi-Cloud Burst & Latency Engineering"
    altLabels: ["kubernetes", "multi-cloud", "p95 latency", "semantic caching", "gpu burst", "cloud commit"]
    definition: "Elastic multi-cloud Kubernetes bursting, semantic token caching, and p95 latency SLO architecture."
    broader: "tech:ai-platform"
    related: ["fin:unit-economics-finops", "ops:sla-reliability"]

  - id: "tech:security-zero-trust"
    domain: "technology"
    prefLabel: "Zero-Trust Security & Integration Architecture"
    altLabels: ["zero-trust", "identity federation", "sso", "encryption", "adapter gateway", "technical debt", "api schema"]
    definition: "Enterprise zero-trust security controls, tenant isolation, cryptographic keys, and post-merger API gateways."
    broader: null
    related: ["gov:dora-cyber-resilience", "strat:ma-corporate-dev"]

  # --- FINANCE DOMAIN (CFO) ---
  - id: "fin:capital-allocation"
    domain: "finance"
    prefLabel: "Capital Allocation & Treasury"
    altLabels: ["capital envelope", "budget", "free cash flow", "fcf", "cash conversion", "treasury"]
    definition: "Enterprise capital deployment standards, hurdle rates, free cash flow preservation, and balance-sheet policy."
    broader: null
    related: ["strat:ma-corporate-dev"]

  - id: "fin:capex-tranche-governance"
    domain: "finance"
    prefLabel: "CAPEX/OPEX Tranche & Payback Gates"
    altLabels: ["40/60 tranche", "payback", "milestone tranche", "capex", "opex", "11-month payback", "hurdle rate"]
    definition: "Staged release of infrastructure and growth capital gated by verified payback windows and ARR milestones."
    broader: "fin:capital-allocation"
    related: ["tech:sovereign-ai-infra", "ops:emea-delivery-pods"]

  - id: "fin:unit-economics-finops"
    domain: "finance"
    prefLabel: "Unit Economics, Gross Margin & EBITDA"
    altLabels: ["gross margin", "ebitda", "arr", "nrr", "net dollar retention", "bps", "finops", "token cost", "cogs"]
    definition: "SaaS and AI unit economics, 74%+ gross margin floors, compute FinOps, EBITDA expansion, and ARR quality."
    broader: "fin:capital-allocation"
    related: ["tech:multicloud-elasticity", "strat:agentic-pricing"]

  # --- OPERATIONS DOMAIN (COO) ---
  - id: "ops:global-service-delivery"
    domain: "operations"
    prefLabel: "Global Service Delivery & Onboarding"
    altLabels: ["onboarding", "implementation", "solutions engineering", "customer operations", "14-day onboarding"]
    definition: "Enterprise customer onboarding workflows, solutions architecture delivery, and time-to-value standards."
    broader: null
    related: ["ops:sla-reliability"]

  - id: "ops:emea-delivery-pods"
    domain: "operations"
    prefLabel: "EMEA Regional Tiger Pods & Go-To-Market Ops"
    altLabels: ["emea", "dach", "france", "europe", "tiger pods", "regional rollout", "procurement velocity"]
    definition: "Cross-functional European regional deployment squads accelerating regulated enterprise bookings and rollout."
    broader: "ops:global-service-delivery"
    related: ["tech:sovereign-ai-infra", "gov:eu-data-residency", "strat:international-expansion"]

  - id: "ops:sla-reliability"
    domain: "operations"
    prefLabel: "Enterprise SLA, Vendor & Incident Governance"
    altLabels: ["sla", "uptime", "incident", "churn", "retention", "vendor management", "99.95%", "runbook"]
    definition: "Contractual service-level commitments, vendor resilience tiers, escalation runbooks, and churn mitigation."
    broader: "ops:global-service-delivery"
    related: ["tech:multicloud-elasticity", "gov:dora-cyber-resilience"]

  # --- GOVERNANCE DOMAIN (CEO / LEGAL & RISK) ---
  - id: "gov:eu-data-residency"
    domain: "governance"
    prefLabel: "EU GDPR & Sovereign Data Residency"
    altLabels: ["gdpr", "data residency", "schrems", "pii", "data sovereignty", "eu boundary", "dpa"]
    definition: "Binding European data residency, GDPR processor obligations, in-region telemetry retention, and DPA controls."
    broader: null
    related: ["tech:sovereign-ai-infra", "ops:emea-delivery-pods"]

  - id: "gov:dora-cyber-resilience"
    domain: "governance"
    prefLabel: "DORA & Financial Sector Operational Resilience"
    altLabels: ["dora", "ict risk", "iso 27001", "soc 2", "regulatory audit", "exit strategy", "regulated banking"]
    definition: "EU Digital Operational Resilience Act (DORA) ICT third-party requirements, audit rights, and multi-cloud exit plans."
    broader: "gov:eu-data-residency"
    related: ["tech:security-zero-trust", "ops:sla-reliability"]

  - id: "gov:ai-safety-governance"
    domain: "governance"
    prefLabel: "EU AI Act, Model Risk & ACL Governance"
    altLabels: ["eu ai act", "zero-retention", "acl", "access control", "human review", "model governance", "audit log"]
    definition: "AI model zero-retention policies, role-based knowledge ACLs, human-in-the-loop review, and EU AI Act compliance."
    broader: null
    related: ["tech:ai-platform"]

  # --- CORPORATE STRATEGY DOMAIN (CEO / BOARD) ---
  - id: "strat:ma-corporate-dev"
    domain: "corporate_strategy"
    prefLabel: "M&A, Valuation & Post-Merger Integration"
    altLabels: ["acquisition", "m&a", "merger", "due diligence", "valuation", "earnout", "pmi", "target", "synergy"]
    definition: "Board-restricted corporate development, acquisition target diligence, deal structuring, and 90-day PMI playbooks."
    broader: null
    related: ["fin:capital-allocation", "tech:security-zero-trust"]

  - id: "strat:agentic-pricing"
    domain: "corporate_strategy"
    prefLabel: "Autonomous Agent Packaging & Outcome Pricing"
    altLabels: ["pricing", "outcome-based", "seat-based", "execution credits", "packaging", "monetization", "cannibalization"]
    definition: "Hybrid platform-fee plus autonomous execution-credit monetization protecting baseline seat ARR."
    broader: null
    related: ["fin:unit-economics-finops", "tech:ai-platform"]

  - id: "strat:international-expansion"
    domain: "corporate_strategy"
    prefLabel: "International Market & Enterprise ARR Strategy"
    altLabels: ["market expansion", "pipeline", "bookings", "board strategy", "annual plan", "enterprise gtm", "market share"]
    definition: "Multi-quarter geographic expansion targets, strategic enterprise segment positioning, and board OKRs."
    broader: null
    related: ["ops:emea-delivery-pods", "fin:capex-tranche-governance"]
`;

export interface ParsedTaxonomyResult {
  schemeUri: string;
  title: string;
  concepts: SkosConcept[];
  objectProperties: string[];
  warnings: string[];
}

export function parseTaxonomyYaml(yamlContent: string): ParsedTaxonomyResult {
  const raw = loadYaml(yamlContent) as {
    scheme?: { uri?: string; title?: string; namespace?: string };
    objectProperties?: unknown[];
    concepts?: Array<{
      id?: string;
      domain?: string;
      prefLabel?: string;
      altLabels?: unknown[];
      definition?: string;
      broader?: string | null;
      related?: unknown[];
    }>;
  } | null;

  if (!raw || typeof raw !== "object" || !Array.isArray(raw.concepts)) {
    throw new Error(
      "Invalid taxonomy YAML: must contain a top-level `concepts:` array."
    );
  }

  const schemeUri = raw.scheme?.uri?.trim() || "urn:aether:enterprise:taxonomy";
  const title =
    raw.scheme?.title?.trim() || "Aether Enterprise SKOS/OWL Knowledge Taxonomy";
  const namespace = raw.scheme?.namespace?.trim() || "urn:aether:skos:";
  const warnings: string[] = [];
  const seen = new Set<string>();
  const concepts: SkosConcept[] = [];

  for (const item of raw.concepts) {
    const id = String(item?.id || "").trim();
    const prefLabel = String(item?.prefLabel || "").trim();
    const domainKey = String(item?.domain || "corporate_strategy").trim();
    if (!id || !prefLabel) {
      throw new Error(
        "Each concept in `concepts:` requires non-empty `id` and `prefLabel`."
      );
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate concept id in taxonomy YAML: "${id}".`);
    }
    seen.add(id);

    const altLabels = Array.isArray(item.altLabels)
      ? item.altLabels.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const related = Array.isArray(item.related)
      ? item.related.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const broader =
      item.broader && String(item.broader).trim() !== "null"
        ? String(item.broader).trim()
        : null;

    concepts.push({
      id,
      uri: `${namespace}${id.replace(/[^a-zA-Z0-9:_-]/g, "-")}`,
      prefLabel,
      altLabels,
      definition: String(item.definition || prefLabel).trim(),
      domainKey,
      broader,
      related,
    });
  }

  for (const c of concepts) {
    if (c.broader && !seen.has(c.broader)) {
      warnings.push(
        `Concept "${c.id}" references unknown skos:broader "${c.broader}".`
      );
    }
    for (const rel of c.related) {
      if (!seen.has(rel)) {
        warnings.push(
          `Concept "${c.id}" references unknown skos:related "${rel}".`
        );
      }
    }
  }

  const objectProperties = Array.isArray(raw.objectProperties)
    ? raw.objectProperties.map((p) => String(p).trim()).filter(Boolean)
    : [
        "FUNDED_BY",
        "GATED_BY_METRIC",
        "SATISFIES_REGULATION",
        "OPERATED_BY",
        "UNLOCKS_REVENUE",
        "DEPENDS_ON",
        "MITIGATES_RISK",
      ];

  return { schemeUri, title, concepts, objectProperties, warnings };
}

function escTurtle(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

export function exportSkosTurtle(params: {
  schemeUri: string;
  title: string;
  version: number;
  concepts: SkosConcept[];
  objectProperties?: string[];
}): string {
  const { schemeUri, title, version, concepts, objectProperties = [] } = params;
  const topConcepts = concepts.filter((c) => !c.broader);
  const lines: string[] = [
    "@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
    "@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix owl:    <http://www.w3.org/2002/07/owl#> .",
    "@prefix skos:   <http://www.w3.org/2004/02/skos/core#> .",
    "@prefix dct:    <http://purl.org/dc/terms/> .",
    "@prefix aether: <urn:aether:owl:> .",
    "",
    `<${schemeUri}> a skos:ConceptScheme, owl:Ontology ;`,
    `  dct:title "${escTurtle(title)}"@en ;`,
    `  owl:versionInfo "v${version}" ;`,
    ...(topConcepts.length
      ? [
          `  skos:hasTopConcept ${topConcepts
            .map((c) => `<${c.uri}>`)
            .join(", ")} ;`,
        ]
      : []),
    `  dct:publisher "Office of the CEO — Aether Enterprise Knowledge Layer" .`,
    "",
  ];

  for (const prop of objectProperties) {
    lines.push(
      `aether:${prop.replace(/[^A-Za-z0-9_]/g, "_")} a owl:ObjectProperty ;`,
      `  rdfs:label "${escTurtle(prop)}"@en ;`,
      `  rdfs:isDefinedBy <${schemeUri}> .`,
      ""
    );
  }

  for (const c of concepts) {
    lines.push(`<${c.uri}> a skos:Concept ;`);
    lines.push(`  skos:inScheme <${schemeUri}> ;`);
    lines.push(`  skos:notation "${escTurtle(c.id)}" ;`);
    lines.push(`  aether:domain "${escTurtle(c.domainKey)}" ;`);
    lines.push(`  skos:prefLabel "${escTurtle(c.prefLabel)}"@en ;`);
    if (c.altLabels.length) {
      lines.push(
        `  skos:altLabel ${c.altLabels
          .map((a) => `"${escTurtle(a)}"@en`)
          .join(", ")} ;`
      );
    }
    if (c.broader) {
      const parent = concepts.find((x) => x.id === c.broader);
      if (parent) lines.push(`  skos:broader <${parent.uri}> ;`);
    } else {
      lines.push(`  skos:topConceptOf <${schemeUri}> ;`);
    }
    const relUris = c.related
      .map((rid) => concepts.find((x) => x.id === rid)?.uri)
      .filter(Boolean);
    if (relUris.length) {
      lines.push(`  skos:related ${relUris.map((u) => `<${u}>`).join(", ")} ;`);
    }
    lines.push(`  skos:definition "${escTurtle(c.definition)}"@en .`, "");
  }

  return lines.join("\n");
}

// ---------- Deterministic 128-dim L2 Semantic Vector + Lexical Scoring ----------
const STOP = new Set(
  "the and for with from that this into over under about across while within without their there where which have been were will would should could your our are was not but all any can may per via also such each than then them they".split(
    " "
  )
);

function fnv1a(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function stemLite(word: string): string {
  if (word.length > 6 && word.endsWith("ation")) return word.slice(0, -5);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%.-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Signed random-projection feature hashing over stemmed tokens, bigrams, and
 * character n-grams to produce a normalized 128-dim semantic vector.
 */
export function computeSemanticEmbedding(text: string, dim = 128): number[] {
  const vec = new Float64Array(dim);
  const rawTokens = tokenize(text);
  const stems = rawTokens.map(stemLite);

  const addFeature = (feat: string, weight: number) => {
    const h1 = fnv1a(feat, 2166136261);
    const h2 = fnv1a(feat, 1315423911);
    const idx = h1 % dim;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  for (let i = 0; i < stems.length; i++) {
    const s = stems[i];
    const specificity = Math.min(2.2, 0.7 + s.length * 0.14);
    addFeature(`u:${s}`, specificity);
    if (i + 1 < stems.length) {
      addFeature(`b:${s}_${stems[i + 1]}`, 1.35);
    }
    if (s.length >= 5) {
      for (let j = 0; j <= s.length - 4; j++) {
        addFeature(`c:${s.slice(j, j + 4)}`, 0.35);
      }
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from({ length: dim }, () => 0);
  return Array.from(vec, (v) => Math.round((v / norm) * 10000) / 10000);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

export function lexicalBm25Score(
  queryTokens: string[],
  docText: string,
  expandedTerms: string[] = []
): { score: number; matchedTerms: string[] } {
  if (!queryTokens.length) return { score: 0, matchedTerms: [] };
  const docTokens = tokenize(docText);
  if (!docTokens.length) return { score: 0, matchedTerms: [] };

  const tf = new Map<string, number>();
  for (const tok of docTokens) {
    const st = stemLite(tok);
    tf.set(st, (tf.get(st) || 0) + 1);
  }

  const k1 = 1.4;
  const b = 0.72;
  const avgDl = 95;
  const dl = docTokens.length;
  const matched = new Set<string>();
  let raw = 0;

  const uniqueQuery = Array.from(new Set(queryTokens));
  for (const q of uniqueQuery) {
    const st = stemLite(q);
    const freq = tf.get(st) || 0;
    if (freq > 0) {
      matched.add(q);
      const idfBoost = Math.min(2.4, 0.9 + st.length * 0.12);
      raw +=
        idfBoost *
        ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / avgDl))));
    }
  }

  for (const exp of expandedTerms) {
    const st = stemLite(exp.toLowerCase());
    if (st.length >= 3 && (tf.get(st) || 0) > 0 && !matched.has(exp)) {
      raw += 0.45;
      matched.add(`~${exp}`);
    }
  }

  const normalized = Math.min(1, raw / Math.max(2.2, uniqueQuery.length * 1.45));
  return { score: normalized, matchedTerms: Array.from(matched).slice(0, 8) };
}

export function chunkDocumentContent(
  title: string,
  content: string
): Array<{
  chunkIndex: number;
  heading: string;
  content: string;
  tokenCount: number;
  embedding: number[];
}> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current = { heading: title, body: [] as string[] };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (current.body.join(" ").trim().length > 0) sections.push(current);
      current = { heading: headingMatch[1].trim(), body: [] };
    } else if (line.trim()) {
      current.body.push(line.trim());
    }
  }
  if (current.body.join(" ").trim().length > 0) sections.push(current);

  const chunks: Array<{
    chunkIndex: number;
    heading: string;
    content: string;
    tokenCount: number;
    embedding: number[];
  }> = [];

  for (const sec of sections) {
    const full = sec.body.join(" ");
    if (full.length <= 680) {
      const tokens = full.split(/\s+/).filter(Boolean).length;
      chunks.push({
        chunkIndex: chunks.length,
        heading: sec.heading,
        content: full,
        tokenCount: tokens,
        embedding: computeSemanticEmbedding(`${sec.heading} ${full}`),
      });
    } else {
      const sentences = full.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if ((buf + " " + s).length > 620 && buf.length > 140) {
          chunks.push({
            chunkIndex: chunks.length,
            heading: sec.heading,
            content: buf.trim(),
            tokenCount: buf.trim().split(/\s+/).length,
            embedding: computeSemanticEmbedding(`${sec.heading} ${buf}`),
          });
          buf = s;
        } else {
          buf = buf ? `${buf} ${s}` : s;
        }
      }
      if (buf.trim()) {
        chunks.push({
          chunkIndex: chunks.length,
          heading: sec.heading,
          content: buf.trim(),
          tokenCount: buf.trim().split(/\s+/).length,
          embedding: computeSemanticEmbedding(`${sec.heading} ${buf}`),
        });
      }
    }
  }

  if (chunks.length === 0) {
    const clean = content.trim() || title;
    chunks.push({
      chunkIndex: 0,
      heading: title,
      content: clean,
      tokenCount: clean.split(/\s+/).length,
      embedding: computeSemanticEmbedding(`${title} ${clean}`),
    });
  }

  return chunks;
}

// ---------- Auto-Classification (OpenCode Zero-Shot + SKOS Scorer) ----------
export function classifyWithSkosScheme(params: {
  title: string;
  content: string;
  concepts: SkosConcept[];
  maxTags?: number;
}): {
  tags: DocumentClassificationTag[];
  suggestedDomain: string;
  secondaryDomains: string[];
} {
  const { title, content, concepts, maxTags = 4 } = params;
  const fullLower = `${title} ${title} ${content}`.toLowerCase();
  const docVec = computeSemanticEmbedding(`${title}. ${content}`);

  const scored = concepts.map((concept) => {
    let points = 0;
    const matchedSignals: string[] = [];

    const prefLower = concept.prefLabel.toLowerCase();
    if (fullLower.includes(prefLower)) {
      points += 34;
      matchedSignals.push(concept.prefLabel);
    } else {
      const prefWords = tokenize(concept.prefLabel);
      const hits = prefWords.filter((w) => fullLower.includes(w));
      if (hits.length >= 2) {
        points += hits.length * 10;
        matchedSignals.push(hits.join(" "));
      }
    }

    for (const alt of concept.altLabels) {
      const altL = alt.toLowerCase();
      if (altL.length >= 2 && fullLower.includes(altL)) {
        points += altL.includes(" ") ? 19 : 13;
        matchedSignals.push(alt);
      }
    }

    const defTokens = tokenize(concept.definition).filter((w) => w.length >= 5);
    let defHits = 0;
    for (const dt of defTokens) {
      if (fullLower.includes(dt)) defHits++;
    }
    points += Math.min(20, defHits * 4);

    const conceptVec = computeSemanticEmbedding(
      `${concept.prefLabel} ${concept.altLabels.join(" ")} ${concept.definition}`
    );
    const sim = cosineSimilarity(docVec, conceptVec);
    points += Math.round(sim * 28);

    const confidence = Math.min(98, Math.max(42, Math.round(44 + points * 0.68)));
    return {
      concept,
      points,
      confidence,
      matchedSignals: Array.from(new Set(matchedSignals)).slice(0, 5),
    };
  });

  scored.sort((a, b) => b.points - a.points);
  const top = scored.filter((s) => s.points >= 14).slice(0, maxTags);
  const chosen = top.length > 0 ? top : scored.slice(0, 1);

  const domainScores = new Map<string, number>();
  for (const s of chosen) {
    domainScores.set(
      s.concept.domainKey,
      (domainScores.get(s.concept.domainKey) || 0) + s.points
    );
  }
  const rankedDomains = Array.from(domainScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);

  const suggestedDomain = rankedDomains[0] || "corporate_strategy";
  const secondaryDomains = rankedDomains.slice(1, 3);

  return {
    tags: chosen.map((s) => ({
      conceptId: s.concept.id,
      prefLabel: s.concept.prefLabel,
      domainKey: s.concept.domainKey,
      uri: s.concept.uri,
      confidence: s.confidence,
      matchedSignals:
        s.matchedSignals.length > 0 ? s.matchedSignals : ["semantic-similarity"],
      origin: "skos-classifier",
    })),
    suggestedDomain,
    secondaryDomains,
  };
}

export async function autoClassifyDocument(params: {
  title: string;
  content: string;
  concepts: SkosConcept[];
  config?: OpencodeConfig | null;
}): Promise<{
  tags: DocumentClassificationTag[];
  suggestedDomain: string;
  secondaryDomains: string[];
  summary: string;
  classifierMode: "opencode-zero-shot" | "skos-hybrid-classifier";
  extractedEntities: Array<{
    name: string;
    entityType: string;
    domainKey: string;
    taxonomyConceptId: string | null;
    description: string;
    attributes: Record<string, string>;
  }>;
  extractedRelationships: Array<{
    sourceName: string;
    targetName: string;
    predicate: string;
    domainKey: string;
    evidence: string;
  }>;
}> {
  const { title, content, concepts, config } = params;
  const heuristic = classifyWithSkosScheme({ title, content, concepts });
  const conceptMap = new Map(concepts.map((c) => [c.id, c]));

  // Build concise default summary from first informative sentences
  const cleanSentences = content
    .replace(/^#{1,4}\s+.+$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 25);
  let summary =
    cleanSentences.slice(0, 2).join(" ").slice(0, 320) ||
    `${title} — classified under ${heuristic.tags
      .map((t) => t.prefLabel)
      .join(", ")}.`;

  // Heuristic domain-tagged Entity & Relationship extraction so ingestion always enriches the KG
  const heuristicKg = extractHeuristicEntitiesAndEdges({
    title,
    content,
    primaryDomain: heuristic.suggestedDomain,
    tags: heuristic.tags,
  });

  if (config) {
    const schemeDigest = concepts
      .map(
        (c) =>
          `- ${c.id} [${c.domainKey}] "${c.prefLabel}" (alt: ${c.altLabels
            .slice(0, 4)
            .join(", ")})`
      )
      .join("\n");

    const liveRaw = await tryLiveOpencodeCompletion({
      config,
      modelDisplayId: config.ctoModel,
      maxTokens: 650,
      systemPrompt: `You are an Enterprise SKOS/OWL Zero-Shot Document Classifier & Knowledge Graph Extractor.
Classify the document strictly against the provided SKOS concept IDs and extract up to 3 key entities and 2 relationships tagged with one of: technology, finance, operations, governance, corporate_strategy.
Respond ONLY with valid JSON:
{
  "summary": "1-2 sentence executive summary",
  "classifications": [{"conceptId":"tech:sovereign-ai-infra","confidence":94,"signals":["phrase1","phrase2"]}],
  "entities": [{"name":"Entity Name","entityType":"System|Initiative|Metric|Regulation|Team|FinancialInstrument|Product","domainKey":"technology","description":"1 sentence"}],
  "relationships": [{"sourceName":"Entity A","targetName":"Entity B","predicate":"FUNDED_BY|GATED_BY_METRIC|SATISFIES_REGULATION|OPERATED_BY|UNLOCKS_REVENUE|DEPENDS_ON|MITIGATES_RISK","domainKey":"finance","evidence":"short reason"}]
}`,
      userPrompt: `SKOS TAXONOMY SCHEME:\n${schemeDigest}\n\nDOCUMENT TITLE: ${title}\nDOCUMENT BODY:\n${content.slice(
        0,
        2400
      )}`,
    });

    if (liveRaw) {
      const parsed = parseStructuredJson<{
        summary?: string;
        classifications?: Array<{
          conceptId?: string;
          confidence?: number;
          signals?: unknown[];
        }>;
        entities?: Array<{
          name?: string;
          entityType?: string;
          domainKey?: string;
          description?: string;
        }>;
        relationships?: Array<{
          sourceName?: string;
          targetName?: string;
          predicate?: string;
          domainKey?: string;
          evidence?: string;
        }>;
      }>(liveRaw);

      if (parsed && Array.isArray(parsed.classifications)) {
        const llmTags: DocumentClassificationTag[] = [];
        for (const item of parsed.classifications.slice(0, 5)) {
          const concept = item.conceptId ? conceptMap.get(item.conceptId) : null;
          if (!concept) continue;
          llmTags.push({
            conceptId: concept.id,
            prefLabel: concept.prefLabel,
            domainKey: concept.domainKey,
            uri: concept.uri,
            confidence: Math.min(
              99,
              Math.max(55, Math.round(Number(item.confidence) || 86))
            ),
            matchedSignals: Array.isArray(item.signals)
              ? item.signals.slice(0, 4).map(String)
              : ["llm-zero-shot"],
            origin: "llm-zero-shot",
          });
        }

        if (llmTags.length > 0) {
          const domains = Array.from(new Set(llmTags.map((t) => t.domainKey)));
          const validDomains = new Set<string>(VALID_DOMAIN_KEYS);
          const llmEntities = Array.isArray(parsed.entities)
            ? parsed.entities
                .filter((e) => e?.name && String(e.name).trim().length > 2)
                .slice(0, 4)
                .map((e) => ({
                  name: String(e.name).trim(),
                  entityType: String(e.entityType || "Initiative").trim(),
                  domainKey: validDomains.has(String(e.domainKey))
                    ? String(e.domainKey)
                    : domains[0],
                  taxonomyConceptId: llmTags[0]?.conceptId || null,
                  description: String(e.description || title).trim(),
                  attributes: {},
                }))
            : heuristicKg.entities;

          const llmRels = Array.isArray(parsed.relationships)
            ? parsed.relationships
                .filter((r) => r?.sourceName && r?.targetName)
                .slice(0, 4)
                .map((r) => ({
                  sourceName: String(r.sourceName).trim(),
                  targetName: String(r.targetName).trim(),
                  predicate: String(r.predicate || "DEPENDS_ON")
                    .toUpperCase()
                    .replace(/[^A-Z0-9_]/g, "_"),
                  domainKey: validDomains.has(String(r.domainKey))
                    ? String(r.domainKey)
                    : domains[0],
                  evidence: String(r.evidence || title).trim(),
                }))
            : heuristicKg.relationships;

          return {
            tags: llmTags,
            suggestedDomain: domains[0],
            secondaryDomains: domains.slice(1, 3),
            summary: parsed.summary?.trim() || summary,
            classifierMode: "opencode-zero-shot",
            extractedEntities:
              llmEntities.length > 0 ? llmEntities : heuristicKg.entities,
            extractedRelationships:
              llmRels.length > 0 ? llmRels : heuristicKg.relationships,
          };
        }
      }
    }
  }

  return {
    tags: heuristic.tags,
    suggestedDomain: heuristic.suggestedDomain,
    secondaryDomains: heuristic.secondaryDomains,
    summary,
    classifierMode: "skos-hybrid-classifier",
    extractedEntities: heuristicKg.entities,
    extractedRelationships: heuristicKg.relationships,
  };
}

function extractHeuristicEntitiesAndEdges(params: {
  title: string;
  content: string;
  primaryDomain: string;
  tags: DocumentClassificationTag[];
}) {
  const { title, content, primaryDomain, tags } = params;
  const entities: Array<{
    name: string;
    entityType: string;
    domainKey: string;
    taxonomyConceptId: string | null;
    description: string;
    attributes: Record<string, string>;
  }> = [];
  const relationships: Array<{
    sourceName: string;
    targetName: string;
    predicate: string;
    domainKey: string;
    evidence: string;
  }> = [];

  const money = content.match(/\$[\d,.]+\s*[MBKmbk]?/g) || [];
  const pct = content.match(/\d+(\.\d+)?%/g) || [];
  const attrs: Record<string, string> = {};
  if (money[0]) attrs.financialFigure = money[0];
  if (pct[0]) attrs.targetMetric = pct[0];

  const rootName = title.replace(/^(RFC|POL|FIN|OPS|STRAT|MEMO)[-:\s0-9]+/i, "").trim().slice(0, 64);
  entities.push({
    name: rootName,
    entityType:
      primaryDomain === "technology"
        ? "System"
        : primaryDomain === "finance"
        ? "FinancialInstrument"
        : primaryDomain === "governance"
        ? "Regulation"
        : "Initiative",
    domainKey: primaryDomain,
    taxonomyConceptId: tags[0]?.conceptId || null,
    description: `Canonical enterprise artifact: ${title}`,
    attributes: attrs,
  });

  // Link to any cross-domain tag concept as a second domain-tagged entity so cross-domain subgraphs grow naturally
  for (const tag of tags.slice(0, 2)) {
    if (tag.prefLabel.toLowerCase() === rootName.toLowerCase()) continue;
    entities.push({
      name: tag.prefLabel,
      entityType:
        tag.domainKey === "governance"
          ? "Regulation"
          : tag.domainKey === "finance"
          ? "Metric"
          : tag.domainKey === "operations"
          ? "Team"
          : "Initiative",
      domainKey: tag.domainKey,
      taxonomyConceptId: tag.conceptId,
      description: `SKOS governed capability node (${tag.conceptId}) referenced in "${title}".`,
      attributes: { skosId: tag.conceptId },
    });
    relationships.push({
      sourceName: rootName,
      targetName: tag.prefLabel,
      predicate:
        tag.domainKey === "governance"
          ? "SATISFIES_REGULATION"
          : tag.domainKey === "finance"
          ? "GATED_BY_METRIC"
          : tag.domainKey === "operations"
          ? "OPERATED_BY"
          : "INTEGRATES_WITH",
      domainKey: tag.domainKey,
      evidence: `Auto-extracted from "${title}" (signals: ${tag.matchedSignals
        .slice(0, 2)
        .join(", ")})`,
    });
  }

  return { entities, relationships };
}

export function slugifyKey(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `item-${Date.now()}`
  );
}
