// Ambient declaration for Intl.Segmenter (ES2022 Intl).
//
// The project targets ES2021, whose default lib does not include
// Intl.Segmenter, and @types/node does not expose it as a global. The
// Node 18+ runtime provides it natively — this only fills in the types.
// Used for word movement/deletion in the inline edit field.

declare namespace Intl {
    interface SegmentData {
        segment: string;
        index: number;
        input: string;
        isWordLike: boolean;
    }

    interface Segments extends Iterable<SegmentData> {
        containing(sourceIndex?: number): SegmentData;
    }

    interface SegmenterOptions {
        granularity?: "grapheme" | "word" | "sentence";
        localeMatcher?: "lookup" | "best fit";
    }

    class Segmenter {
        constructor(locales?: string | string[], options?: SegmenterOptions);
        segment(input: string): Segments;
    }
}
