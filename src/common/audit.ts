export const ALLOWED_COMMAND_ENTRY_TYPE = "pi-bash-sandbox:allowed-bash-command";

export interface AllowedCommandEntry {
    command: string;
    permission: "allow" | "allow:sandbox";
    // Optional user-provided message explaining the decision
    userMessage?: string;
}
