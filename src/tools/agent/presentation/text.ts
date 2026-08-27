import type { AgentDiagnostic } from "../definitions/discovery";

/** Render an agent discovery diagnostic for user-facing messages and metadata. */
export function diagnosticText(diagnostic: AgentDiagnostic): string {
    const paths = diagnostic.paths.length ? ` [${diagnostic.paths.join(", ")}]` : "";
    return `${diagnostic.message}${paths}`;
}
