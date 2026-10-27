/** Paths are relative to the owning deployment's memory/data directory. */
export interface BotCopyRules {
    settingsInMemory: string[];
}
export interface WorldCopyRules {
    /** Files/directories below dataDir; never include process locks or login keys. */
    state?: string[];
    /** External connection fields in worlds.<id> and secret names in deployment .env. */
    connection?: {keys: string[]; secrets: string[]};
}
