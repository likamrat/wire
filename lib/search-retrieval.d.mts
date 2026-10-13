import type { CorpusEntry, CorpusReceipt, CorpusStatus, CorpusType } from "./search-corpus.mjs";

export type SearchMode = "hybrid" | "lexical-only" | "unavailable";
export interface SearchModelStatus {
    readonly state: "uninitialized" | "loading" | "computing" | "ready" | "cancelled" | "unavailable" | "closed";
    readonly modelId: string;
    readonly code?: string;
    readonly coldMs: number | null;
    readonly loadMs: number | null;
    readonly inferenceMs: number | null;
    readonly rss: number | null;
    readonly peakRss: number | null;
}
export interface SearchStatus {
    readonly state: CorpusStatus["state"] | "building" | "searching" | "no-match";
    readonly mode: SearchMode;
    readonly corpus: CorpusStatus;
    readonly modelId: string;
    readonly model: SearchModelStatus;
    readonly linguistics: Readonly<{
        state: "disabled" | "uninitialized" | "loading" | "computing" | "ready" | "cancelled" | "unavailable" | "closed";
        policyId: string; code?: string; loadMs: number | null; operationMs: number | null; rss: number | null; peakRss: number | null;
    }>;
    readonly indexId: string | null;
    readonly items: number;
    readonly chunks: number;
    readonly count?: number;
    readonly requestId?: number;
    readonly metrics: Readonly<{ buildMs?: number; encodeBuildMs?: number; linguisticBuildMs?: number;
        searchMs?: number; queryInferenceMs?: number; linguisticMs?: number; deliveryMs?: number }>;
}
export interface SearchHit extends CorpusEntry {
    readonly match: "exact" | "prefix" | "semantic";
}
export interface SearchReceipt extends CorpusReceipt {
    readonly requestId: number;
    readonly indexId: string;
    readonly modelId: string;
    readonly mode: SearchMode;
}
export interface RelatedHit extends CorpusEntry {
    readonly match: "related";
    readonly purpose: "navigate-only";
}
export interface MatchDiscoveryReceipt extends SearchReceipt {
    readonly purpose: "strict-match-population";
    readonly matchPolicyId: string;
    readonly types: readonly CorpusType[];
}
/** A discovery stamp, not an analytical membership receipt. */
export interface RelatedReceipt extends SearchReceipt {
    readonly purpose: "related-navigation";
    readonly relatedPolicyId: string;
    readonly types: readonly CorpusType[];
}
export interface RelatedCoverage {
    readonly evaluatedItems: number;
    readonly corpusState: "ready" | "partial";
    readonly populationComplete: false;
}
export type RelatedResult =
    | { readonly state: "available"; readonly hits: readonly RelatedHit[]; readonly receipt: RelatedReceipt;
        readonly coverage: RelatedCoverage }
    | { readonly state: "unavailable"; readonly reason: "model-unavailable"; readonly hits: readonly [];
        readonly receipt: null; readonly coverage: RelatedCoverage };
export interface SearchDiscovery {
    readonly matches: { readonly hits: readonly SearchHit[]; readonly receipt: MatchDiscoveryReceipt };
    readonly related: RelatedResult;
}
export interface SearchDiscoveryStatus extends SearchStatus {
    /** SearchStatus.count still counts strict matches only. */
    readonly related: Readonly<{
        state: "available" | "unavailable";
        reason?: "model-unavailable" | "not-current";
        policyId: string;
        count: number;
        populationComplete: false;
    }>;
}
export interface SearchRetrieval {
    status(): SearchStatus;
    build(): Promise<SearchStatus>;
    search(input: { query: string; requestId: number; types?: readonly CorpusType[] },
        disclose: (hits: readonly SearchHit[], receipt: SearchReceipt) => undefined): Promise<SearchStatus>;
    /** Shares search's monotonic request IDs and invalidation lifetime; one authorized union disclosure. */
    discover(input: { query: string; requestId: number; types?: readonly CorpusType[] },
        disclose: (result: SearchDiscovery) => undefined): Promise<SearchDiscoveryStatus>;
    invalidate(): SearchStatus;
    /** Clears state synchronously; the promise settles after the owned helper exits. */
    close(): Promise<void>;
}
export function createSearchRetrieval(session: object, options: {
    source: (state: object) => { available: boolean; sourceConfigRef: string | null; sourceConfigRevision: number };
    modelDirectory?: string;
    /** Opt-in partial lexical-semantic increment; never provisioned implicitly. */
    linguisticsDirectory?: string;
    onInvalidate: (receipt: CorpusReceipt) => undefined;
    /** Content-free local lifecycle diagnostics, not a query/usage log. */
    onModelActivity?: (event: Readonly<{ state: "starting" | "computing" | "computed" }>) => undefined;
    onLinguisticsActivity?: (event: Readonly<{ state: "starting" | "computing" | "computed" }>) => undefined;
}): SearchRetrieval;
