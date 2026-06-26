export { VaultError } from "./vault-error.js";
export { resolvePath } from "./path-security.js";
export { resolveObservationSource } from "./provenance.js";
export type { ResolvedSource } from "./provenance.js";
export { ScopeDefinition, parseScopes, checkInScope, canSourceAccess } from "./scope.js";
export {
  ParsedObservation,
  parseObservationsFromFile,
  parseObservationBlock,
  parseInlineTagList,
  splitObservationEntries,
} from "./observation-parser.js";
export { VERSION } from "./version.js";
export {
  VaultBase,
  VaultConfig,
  collectMdFiles,
  today,
  monthLabel,
  isoDate,
} from "./vault-core.js";
export {
  readManifest,
  rebuildManifest,
  type VaultManifest,
} from "./manifest.js";
export type { BootstrapContent, BootstrapTier } from "./vault-core.js";
export {
  recencyWeight,
  ageInDays,
  DEFAULT_HALF_LIFE_DAYS,
} from "./recency.js";
export {
  confidenceWeight,
  defaultSourceTrust,
  observationScore,
  clusterScore,
  distinctSources,
  evaluatePromotion,
  PromotionOptions,
  PromotionDecision,
  SourceTrustFn,
} from "./promotion.js";
export {
  ACCESS_LOG_PATH,
  ACCESS_CHECKPOINT_PATH,
  observationId,
  appendAccessEntries,
  loadAccessCounts,
  AccessEntry,
} from "./access-log.js";
export {
  AuditChain,
  AuditEntry,
  AuditChainOptions,
  VerifyResult,
  verifyAuditChain,
  sharedAuditChain,
  GENESIS_HASH,
  canonicalJson,
  hashEntry,
} from "./audit-chain.js";
export {
  search,
  bm25Score,
  buildCorpusStats,
  tagJaccard,
  tokenize,
  DEFAULT_WEIGHTS,
  SearchOptions,
  SearchResult,
  ScoreBreakdown,
} from "./search.js";
export {
  computeVaultHealth,
  formatVaultHealthReport,
  VaultHealthReport,
} from "./vault-health.js";
export {
  REACTION_KINDS,
  isValidReactionKind,
  reactionFilePath,
  serializeReaction,
  parseReaction,
  addReaction,
  listReactions,
  listAllReactions,
  summarizeReactions,
} from "./reactions.js";
export type { ReactionKind, Reaction } from "./reactions.js";
export {
  serializeSynthesis,
  parseSynthesis,
  draftFilePath,
  synthesisFilePath,
  writeDraft,
  writeSynthesis,
  listDrafts,
  listSyntheses,
  latestSynthesis,
  nextVersion,
} from "./synthesis.js";
export type { Synthesis, DraftOptions, SynthesisOptions } from "./synthesis.js";
export { mergeDrafts } from "./merge.js";
export type { MergeOptions, MergeResult } from "./merge.js";
export {
  TRUST_LOG_PATH,
  DEFAULT_TRUST,
  TRUST_MIN,
  TRUST_MAX,
  DEFAULT_TRUST_HALF_LIFE_DAYS,
  appendTrustAdjustments,
  loadSourceTrust,
  makeSourceTrustResolver,
  TrustAdjustment,
} from "./trust.js";
export { listStaleFacts, formatStaleReview } from "./demotion.js";
export type { StaleFact, StaleReviewOptions } from "./demotion.js";
export {
  evaluateSynthesisTriggers,
  DEFAULT_THRESHOLDS as SYNTHESIS_TRIGGER_DEFAULTS,
} from "./synthesis-triggers.js";
export type {
  SynthesisTriggerInput,
  SynthesisTriggerDecision,
  TriggerReason,
} from "./synthesis-triggers.js";
export {
  collectTagUsage,
  findMergeCandidates,
  formatMergeCandidates,
} from "./tag-normalization.js";
export type {
  TagUsage,
  MergeCandidate,
} from "./tag-normalization.js";
