// src/components/SlackPreview/message.ts — narrows any JSON to the Block Kit subset SlackPreview draws.

export type TextObject = { type?: string; text?: string; emoji?: boolean };

export interface Block {
  type?: string;
  text?: TextObject;
  fields?: TextObject[];
  elements?: {
    type?: string;
    text?: TextObject | string;
    style?: string;
    url?: string;
    alt_text?: string;
  }[];
  block_id?: string;
}

export interface Message {
  text?: string;
  blocks?: Block[];
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Narrows any JSON to the shape this renderer understands (a Slack message body or a bare blocks array). */
export function toSlackMessage(input: unknown): Message | null {
  if (Array.isArray(input)) return { blocks: input.filter(isObject) as Block[] };
  if (!isObject(input)) return null;
  const blocks = Array.isArray(input.blocks) ? (input.blocks.filter(isObject) as Block[]) : undefined;
  const text = typeof input.text === 'string' ? input.text : undefined;
  if (!blocks && text === undefined) return null;
  return { blocks, text };
}
