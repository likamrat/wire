import type { CorpusType } from "./search-corpus.mjs";
import type { SearchHit, RelatedHit, SearchStatus } from "./search-retrieval.mjs";

export type QueryPurpose = "navigation" | "analysis";
export interface SearchWireQuery {
    readonly schemaVersion: 2;
    readonly purpose: QueryPurpose;
    readonly query: string;
    readonly requestId: number;
    readonly types?: readonly CorpusType[];
}
interface QueryStamp {
    readonly schemaVersion: 2;
    readonly panelId: string;
    readonly epoch: number;
    readonly requestId: number;
    readonly generation: number;
    readonly indexId: string;
    readonly modelId: string;
    readonly mode: "hybrid" | "lexical-only";
    readonly revision: number;
    readonly queryTypes: readonly CorpusType[];
}
export interface MatchReceipt extends QueryStamp {
    readonly purpose: "strict-match-population";
    readonly queryPurpose: QueryPurpose;
    readonly matchPolicyId: string;
}
export interface RelatedReceipt extends QueryStamp {
    readonly purpose: "related-navigation";
    readonly queryPurpose: "navigation";
    readonly mode: "hybrid";
    readonly relatedPolicyId: string;
}
export type SearchWireReceipt = MatchReceipt | RelatedReceipt;
export interface MatchSet {
    readonly receipt: MatchReceipt;
    readonly hits: readonly Omit<SearchHit, "content">[];
    readonly total: number;
}
export interface RelatedSet {
    readonly receipt: RelatedReceipt;
    readonly hits: readonly Omit<RelatedHit, "content">[];
    readonly total: number;
    readonly coverage: {
        readonly evaluatedItems: number;
        readonly corpusState: "ready" | "partial";
        readonly retrieval: "policy-selected-candidates";
        readonly populationComplete: false;
    };
}
interface ResultStamp {
    readonly schemaVersion: 2;
    readonly panelId: string;
    readonly epoch: number;
    readonly event: "results";
    readonly requestId: number;
    readonly status: SearchStatus;
}
type MatchesFor<P extends QueryPurpose, M extends MatchReceipt["mode"] = MatchReceipt["mode"]> =
    Omit<MatchSet, "receipt"> & { readonly receipt: MatchReceipt & { readonly queryPurpose: P; readonly mode: M } };
export type SearchResultsEvent =
    | ResultStamp & { readonly purpose: "analysis"; readonly matches: MatchesFor<"analysis">; readonly related?: never }
    | ResultStamp & { readonly purpose: "navigation"; readonly matches: MatchesFor<"navigation", "hybrid">; readonly related: RelatedSet }
    | ResultStamp & { readonly purpose: "navigation"; readonly matches: MatchesFor<"navigation", "lexical-only">; readonly related?: never };
export interface SearchWireContract {
    readonly schemaVersion: 2;
    readonly allTypes: readonly CorpusType[];
    readonly matchPolicyId: string;
    readonly relatedPolicyId: string;
    readonly lexicalPolicies: Readonly<{ matchPolicyId: string; relatedPolicyId: string }> | null;
    canonicalTypes(values: unknown): CorpusType[] | null;
    handshake(value: unknown): void;
    query(value: unknown): { query: string; requestId: number; purpose: QueryPurpose; types: CorpusType[] };
    receipt(value: unknown): SearchWireReceipt;
    validReceipt(value: unknown): value is SearchWireReceipt;
    analysisReceipt(value: unknown): value is MatchReceipt & { queryPurpose: "analysis" };
    sameReceipt(a: unknown, b: unknown): boolean;
    validResults(value: unknown): value is SearchResultsEvent;
}
export function createSearchWireContract(options: {
    matchPolicyId: string; relatedPolicyId: string; types: readonly CorpusType[];
    lexicalPolicies?: Readonly<{ matchPolicyId: string; relatedPolicyId: string }> | null;
}): SearchWireContract;
export const searchWireContract: SearchWireContract;
