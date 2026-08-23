export const ALLOWED_COMMAND_ENTRY_TYPE = "pi-bash-sandbox:allowed-bash-command";
export const ALLOWED_FILE_ENTRY_TYPE = "pi-file-sandbox:allowed-file-folder";

export interface AllowedFileEntry {
    operation: "read" | "write";
    folder: string;
}

export interface AllowedCommandEntry {
    command: string;
    permission: "allow" | "allow:sandbox";
    // Optional user-provided message explaining the decision
    userMessage?: string;
}
