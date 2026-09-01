/**
 * What a child must put in its final message to the parent.
 *
 * Two sentences rather than one conditional, because they describe different deliverables: a worker
 * owes an account of what it changed, and an investigator owes evidence for what it concluded. Every
 * profile picks one by name, so adding a profile cannot silently inherit the wrong expectation.
 */

export function changeReportExpectation(): string {
    return "When finished, give the parent a self-contained report with a summary, every changed file, validation performed, and any unresolved concern.";
}

export function findingsReportExpectation(): string {
    return "When finished, give the parent a self-contained report with your findings, supporting evidence, limitations, and useful next steps.";
}
