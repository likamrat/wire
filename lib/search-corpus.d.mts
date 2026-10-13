export type CorpusType = "interaction" | "context" | "reply" | "action" | "tool" | "service" | "report" | "comparison" | "view" | "setting";
export type CorpusTarget =
    | { readonly kind: "route"; readonly href: `#${"analyze" | "request" | "reports" | "settings" | "collection-status"}${string}`;
        readonly focus?: "percentageCharts" | "recordedTiming" | "homeFindings" }
    | { readonly kind: "open-saved-report" | "open-saved-comparison"; readonly bundleId: string;
        readonly revision: string; readonly manifestHash: string; readonly documentHash: string }
    | { readonly kind: "open-saved-report-file"; readonly format: "json" | "markdown" | "pdf"; readonly bundleId: string;
        readonly revision: string; readonly manifestHash: string; readonly documentHash: string };
export interface CorpusEntry {
    readonly id: string;
    readonly type: CorpusType;
    readonly category: string;
    readonly title: string;
    readonly content: string;
    readonly excerpt: string;
    readonly contentHash: string;
    readonly revision: string;
    readonly source: {
        readonly kind: "retained-activity" | "retained-reply" | "fixed-navigation" | "saved-report" | "saved-comparison";
        readonly id: string;
        readonly label: string;
        readonly revision: string;
    };
    readonly target: CorpusTarget;
    readonly coverage: Readonly<{
        completeness?: "full" | "partial" | "unavailable" | "full-record" | "bounded-fragment";
        author?: "user" | "agent" | "unknown" | "assistant";
        authorBasis?: string;
        finality?: "unverified";
        relation?: string;
        gaps?: readonly string[];
        limitation?: string;
        linkedInteractions?: readonly string[];
        layer?: string;
        outcome?: string;
        attribution?: string;
        textMode?: "none" | "masked" | "original" | "unrecorded";
        frozen?: boolean;
        format?: "html" | "json" | "markdown" | "pdf";
        representation?: "markdown-source" | "pdf-text-layer";
        pages?: number;
        pagesWithText?: number;
        contextEntries?: number;
        contextIncluded?: number;
        contextPartial?: number;
        contextUnavailable?: number;
        contextOmitted?: number;
    }>;
}
export interface CorpusStatus {
    readonly state: "uninitialized" | "ready" | "partial" | "stale" | "unavailable" | "superseded" | "closed";
    readonly generation: number;
    readonly items: number;
    readonly textBytes: number;
    readonly issues: readonly {
        readonly sourceId: string;
        readonly code: string;
        /** Source-owned affected types; absent or unknown coverage remains fail-closed. */
        readonly types?: readonly CorpusType[];
    }[];
}
export interface CorpusReceipt { readonly generation: number }
export interface CorpusTicket extends CorpusReceipt {
    readonly hits: readonly { readonly id: string; readonly revision: string }[];
}
export interface SearchCorpus {
    status(): CorpusStatus;
    invalidate(): CorpusStatus;
    close(): CorpusStatus;
    rebuild(): Promise<CorpusStatus>;
    index<T>(build: (entries: readonly CorpusEntry[], options: { signal: AbortSignal }) => T | Promise<T>,
        publish: (value: T, receipt: CorpusReceipt) => undefined): Promise<CorpusStatus>;
    deliver(ticket: CorpusTicket, disclose: (hits: readonly CorpusEntry[]) => undefined): Promise<CorpusStatus>;
}
export function createSearchCorpus(session: object, options: {
    source: (state: object) => { available: boolean; sourceConfigRef: string | null; sourceConfigRevision: number };
    onInvalidate: (receipt: CorpusReceipt) => undefined;
}): SearchCorpus;
