// scripts/package.d.mts — types for the parts of scripts/package.mjs that tests import (the packaged README).

export declare const PUBLIC_REPO: string;
export declare const REPO_SUBDIR: string;
export declare const REPO_URL: string;
export declare function repoFileUrl(path: string, publicRepo?: string): string;
export declare const HERO_IMAGE: { readonly from: string; readonly to: string };
export declare const HERO_MAX_BYTES: number;
export declare const README_IMAGES: { readonly from: string; readonly to: string };
export declare function mediaSizeProblems(sizes: ReadonlyMap<string, number>): string[];
export declare const REPO_ONLY_SECTIONS: readonly string[];
export declare const APP_ICON: string;
export declare const SCAFFOLD_ICON: RegExp;
export declare function headingSlug(heading: string): string;
export declare function headingAnchors(markdown: string): Set<string>;
export declare function linkSpans(line: string): { image: boolean; target: string; start: number; end: number }[];
export declare function markdownLinks(markdown: string): { line: number; image: boolean; target: string }[];
export declare function packagedReadme(markdown: string, repoUrl?: string, publicRepo?: string): string;
export declare function readmeLinkProblems(markdown: string, has: (path: string) => boolean): string[];
export declare const LICENSE_JSON: string;
export declare const THIRD_PARTY_FILE: string;
export interface FontNotice {
  readonly family: string;
  readonly file: RegExp;
  readonly from: string;
  readonly license: string;
  /** Repository path of the license text. */
  readonly text: string;
}
export declare const FONT_NOTICES: readonly FontNotice[];
export declare function shippedFonts(assetNames: readonly string[]): FontNotice[];
export declare function thirdPartyNotices(
  packages: readonly { name: string; version: string; identifier?: string; text?: string }[],
  fonts: readonly { family: string; from: string; license: string; text: string }[],
): string;
