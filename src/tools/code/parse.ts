import type { SupportedLanguage } from "./languages";
import { parseWithAdapter } from "./adapters";
import type { ParsedFile } from "./types";

/** Parse one supported source file with the adapter that matches its language. */
export async function parseCodeFile(
    source: string,
    filePath: string,
    language: SupportedLanguage,
): Promise<ParsedFile> {
    return await parseWithAdapter(source, filePath, language);
}
