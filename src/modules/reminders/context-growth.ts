/**
 * How much context has grown since the last reminder, estimated the way the rest of the extension estimates
 * it: an assistant message's usage is the baseline, and streamed text is `chars / 4` on top until the next
 * usage number arrives.
 */
export class ContextGrowthTracker {
    private baseline = 0;
    private streamedChars = 0;
    private peak = 0;

    /** A new agent run has no baseline until the first assistant usage arrives. */
    reset(): void {
        this.baseline = 0;
        this.streamedChars = 0;
        this.peak = 0;
    }

    /** Start of an assistant message: its context usage is the new baseline. */
    startAssistantMessage(tokens: number): void {
        this.baseline = tokens;
        this.streamedChars = 0;

        if (tokens > this.peak) {
            this.peak = tokens;
        }
    }

    /** Streamed assistant text or thinking, estimated at four characters per token. */
    addStreamedChars(chars: number): void {
        this.streamedChars += chars;

        const estimated = this.baseline + Math.ceil(this.streamedChars / 4);
        if (estimated > this.peak) {
            this.peak = estimated;
        }
    }

    /** The highest estimate observed since the last reset. */
    get maxTokens(): number {
        return this.peak;
    }
}
