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
    readonly indexId: string | null;
    readonly items: number;
    readonly chunks: number;
    readonly count?: number;
    readonly requestId?: number;
    readonly metrics: Readonly<{ buildMs?: number; encodeBuildMs?: number; searchMs?: number; queryInferenceMs?: number; deliveryMs?: number }>;
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
export interface SearchRetrieval {
    status(): SearchStatus;
    build(): Promise<SearchStatus>;
    search(input: { query: string; requestId: number; types?: readonly CorpusType[] },
        disclose: (hits: readonly SearchHit[], receipt: SearchReceipt) => undefined): Promise<SearchStatus>;
    invalidate(): SearchStatus;
    /** Clears state synchronously; the promise settles after the owned helper exits. */
    close(): Promise<void>;
}
export function createSearchRetrieval(session: object, options: {
    source: (state: object) => { available: boolean; sourceConfigRef: string | null; sourceConfigRevision: number };
    modelDirectory?: string;
    onInvalidate: (receipt: CorpusReceipt) => undefined;
    /** Content-free local lifecycle diagnostics, not a query/usage log. */
    onModelActivity?: (event: Readonly<{ state: "starting" | "computing" | "computed" }>) => undefined;
}): SearchRetrieval;
