import type { CorpusEntry, CorpusReceipt, CorpusStatus, CorpusType } from "./search-corpus.mjs";

export type SearchMode = "text" | "unavailable";
export interface SearchStatus {
    readonly state: CorpusStatus["state"] | "building" | "searching" | "empty" | "no-match";
    readonly mode: SearchMode;
    readonly corpus: CorpusStatus;
    readonly indexId: string | null;
    readonly items: number;
    readonly count?: number;
    readonly requestId?: number;
    readonly metrics: Readonly<{ buildMs?: number; searchMs?: number; deliveryMs?: number }>;
}
export interface TextMatch {
    /** source means the already-admitted source.label, never operational metadata. */
    readonly field: "title" | "content" | "source";
    /** Original field UTF-16 offsets, grapheme-aligned and end-exclusive. */
    readonly start: number;
    readonly end: number;
    /** The original field offset at which the returned excerpt begins. */
    readonly excerptStart: number;
}
export interface SearchHit extends CorpusEntry {
    readonly match: "text";
    readonly textMatch: TextMatch;
}
export interface SearchReceipt extends CorpusReceipt {
    readonly requestId: number;
    readonly indexId: string;
    readonly mode: "text";
}
export interface MatchDiscoveryReceipt extends SearchReceipt {
    readonly purpose: "strict-match-population";
    readonly matchPolicyId: string;
    readonly types: readonly CorpusType[];
}
export interface SearchDiscovery {
    readonly matches: { readonly hits: readonly SearchHit[]; readonly receipt: MatchDiscoveryReceipt };
}
export type SearchDiscoveryStatus = SearchStatus;
export interface SearchRetrieval {
    status(): SearchStatus;
    build(): Promise<SearchStatus>;
    search(input: { query: string; requestId: number; types?: readonly CorpusType[] },
        disclose: (hits: readonly SearchHit[], receipt: SearchReceipt) => undefined): Promise<SearchStatus>;
    /** Same complete text population and monotonic request lifetime as search. */
    discover(input: { query: string; requestId: number; types?: readonly CorpusType[] },
        disclose: (result: SearchDiscovery) => undefined): Promise<SearchStatus>;
    invalidate(): SearchStatus;
    /** Clears synchronously, then awaits active corpus/parser operations. */
    close(): Promise<void>;
}
export function createSearchRetrieval(session: object, options: {
    source: (state: object) => { available: boolean; sourceConfigRef: string | null; sourceConfigRevision: number };
    onInvalidate: (receipt: CorpusReceipt) => undefined;
}): SearchRetrieval;
