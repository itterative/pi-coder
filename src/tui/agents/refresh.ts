export interface RefreshTarget<T> {
    isDisposed(): boolean;
    apply(data: T): void;
}

/** Coalesces event-driven refresh requests without dropping the final update. */
export class RefreshCoordinator<T> {
    private inFlight = false;
    private pending = false;
    private disposed = false;

    constructor(
        private readonly load: () => Promise<T>,
        private readonly target: RefreshTarget<T>,
        private readonly onError: (error: unknown) => void = (error) =>
            console.error("Agent browser refresh failed:", error),
    ) {}

    schedule(): void {
        if (this.disposed) return;
        if (this.inFlight) {
            this.pending = true;
            return;
        }

        this.inFlight = true;
        void this.run();
    }

    dispose(): void {
        this.disposed = true;
    }

    private async run(): Promise<void> {
        try {
            do {
                this.pending = false;
                const data = await this.load();
                if (this.disposed || this.target.isDisposed()) return;
                this.target.apply(data);
            } while (this.pending && !this.disposed && !this.target.isDisposed());
        } catch (error) {
            this.onError(error);
        } finally {
            this.inFlight = false;
        }
    }
}
