export interface WorkerMutationReport {
    changedFiles: string[];
    readFiles?: string[];
    bashApproved: boolean;
    interrupted?: boolean;
}
