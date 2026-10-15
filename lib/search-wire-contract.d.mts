import type { CorpusType } from "./search-corpus.mjs";
import type { SearchHit, SearchStatus } from "./search-retrieval.mjs";

export type QueryPurpose = "navigation" | "analysis";
export interface SearchWireQuery {
    readonly schemaVersion: 3;
    readonly purpose: QueryPurpose;
    readonly query: string;
    readonly requestId: number;
    readonly types?: readonly CorpusType[];
}
export interface MatchReceipt {
    readonly schemaVersion: 3;
    readonly panelId: string;
    readonly epoch: number;
    readonly requestId: number;
    readonly generation: number;
    readonly indexId: string;
    readonly mode: "text";
    readonly revision: number;
    readonly queryTypes: readonly CorpusType[];
    readonly purpose: "strict-match-population";
    readonly queryPurpose: QueryPurpose;
    readonly matchPolicyId: string;
}
export type SearchWireReceipt = MatchReceipt;
export interface MatchSet {
    readonly receipt: MatchReceipt;
    readonly hits: readonly Omit<SearchHit, "content">[];
    readonly total: number;
}
export interface SearchResultsEvent {
    readonly schemaVersion: 3;
    readonly panelId: string;
    readonly epoch: number;
    readonly event: "results";
    readonly requestId: number;
    readonly purpose: QueryPurpose;
    readonly status: SearchStatus;
    readonly matches: MatchSet;
}
export interface SearchWireContract {
    readonly schemaVersion: 3;
    readonly allTypes: readonly CorpusType[];
    readonly matchPolicyId: string;
    canonicalTypes(values: unknown): CorpusType[] | null;
    handshake(value: unknown): void;
    query(value: unknown): { query: string; requestId: number; purpose: QueryPurpose; types: CorpusType[] };
    receipt(value: unknown): SearchWireReceipt;
    validReceipt(value: unknown): value is SearchWireReceipt;
    analysisReceipt(value: unknown): value is MatchReceipt & { queryPurpose: "analysis" };
    completeCoverage(corpus: unknown, requestedTypes: unknown): boolean;
    sameReceipt(a: unknown, b: unknown): boolean;
    validResults(value: unknown): value is SearchResultsEvent;
}
export function createSearchWireContract(options: { matchPolicyId: string; types: readonly CorpusType[] }): SearchWireContract;
export const searchWireContract: SearchWireContract;
