// scripts/export-wording.d.mts — types for scripts/export-wording.mjs (the public export's own wording), which
// tests/compliance.test.ts imports.

export declare const COMMUNITY_REPO: string;
export declare const PUSHED_AT_SUBMISSION: string;
export declare function stagingReadme(markdown: string): { text: string; rewritten: number[]; mentions: number; problems: string[] };
export declare function exportClaudeMd(markdown: string): { text: string; problems: string[] };
export declare function applyExportWording(out: string, target: 'staging' | 'community'): { problems: string[]; report: string };
