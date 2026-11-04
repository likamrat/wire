export type CorpusType = "interaction" | "context" | "reply" | "action" | "tool" | "service" | "report" | "comparison" | "view" | "setting";
export type CorpusTarget =
    | { readonly kind: "route"; readonly href: `#${"analyze" | "request" | "reports" | "settings" | "collection-status"}${string}`;
        readonly focus?: "percentageCharts" | "recordedTiming" | "homeFindings" | `native-message-${string}` | `native-source-fact-${string}` }
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
        readonly kind: "retained-activity" | "retained-reply" | "retained-native" | "fixed-navigation" | "saved-report" | "saved-comparison";
        readonly id: string;
        readonly label: string;
        readonly revision: string;
    };
    readonly target: CorpusTarget;
    readonly coverage: Readonly<{
        completeness?: "full" | "partial" | "unavailable" | "full-record" | "bounded-fragment";
        activityState?: "automatic" | "empty" | "gap" | "unavailable" | "recorded";
        availabilityNote?: string;
        author?: "user" | "agent" | "unknown" | "assistant" | "tool";
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
        representation?: "markdown-source" | "pdf-text-layer" | "plain-text" | "card-text" | "reply-fragment" | "follow-up";
        sourceId?: "microsoft-365-chat" | "microsoft-365-cowork";
        scope?: Readonly<{ harness: "microsoft-365-copilot"; surface: "chat" | "cowork"; conversationId: string;
            account: Readonly<{ tenantId: string; subjectId: string; verification: "verified" | "unqualified" | "conflicting" }> }>;
        sourceKey?: string;
        observationKey?: string;
        unit?: "message-representation-observation" | "message-representation-part" | "native-tool-call" | "native-returned-result-observation" | "chat-source-observation";
        parentObservationKey?: string;
        partSource?: Readonly<{ sourceDocument: string; pointer: string; nativeEventId: string }>;
        qualification?: string | null;
        factKey?: string;
        factKind?: string;
        factSource?: Readonly<{ sourceDocument: string; pointer: string; decodedPointer?: string }>;
        textSources?: readonly Readonly<{ field: string;
            source: Readonly<{ sourceDocument: string; pointer: string; decodedPointer?: string }> }>[];
        sourceApplicability?: "historical-only-current-unqualified";
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
/** Backend-only frames from the fixture access owner's genuine Microsoft retained lease. */
export interface NativeRetainedFrame {
    readonly revision: string;
    readonly generation: number;
    readonly records: readonly object[];
}
export interface NativeRetainedReader {
    scan(): Promise<NativeRetainedFrame>;
    publish<T>(frame: NativeRetainedFrame, work: () => T): Promise<T>;
    close(): void;
}
export function createSearchCorpus(session: object, options: {
    source: (state: object) => { available: boolean; sourceConfigRef: string | null; sourceConfigRevision: number };
    onInvalidate: (receipt: CorpusReceipt) => undefined;
    nativeReader?: NativeRetainedReader;
}): SearchCorpus;
