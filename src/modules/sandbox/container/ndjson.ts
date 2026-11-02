/**
 * Newline-delimited JSON decoder for the container dispatcher stream.
 *
 * Messages are single-line JSON, and every payload that could contain an arbitrary byte (command output)
 * is base64 inside that JSON, so splitting on `\n` is safe: a raw child byte can never reach the framing
 * layer. Chunks arrive at arbitrary boundaries, so a partial trailing line is kept until the newline.
 */
export class NdjsonDecoder {
    private buffered = "";

    /** Feed one stream chunk and return the complete lines it finished, without their newlines. */
    push(chunk: Buffer | string): string[] {
        this.buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");

        const lines: string[] = [];
        let newline = this.buffered.indexOf("\n");

        while (newline >= 0) {
            const line = this.buffered.slice(0, newline).trim();
            this.buffered = this.buffered.slice(newline + 1);

            if (line.length > 0) {
                lines.push(line);
            }

            newline = this.buffered.indexOf("\n");
        }

        return lines;
    }

    /** The unterminated remainder, for diagnostics only. */
    pending(): string {
        return this.buffered;
    }
}
