import chat from '../../chat.json';
import type { ChatLine, Side } from './protocol';

const characters = new Set(chat.characters);
/** The last part of a line's life, in milliseconds, during which it fades out. */
const fadeTime = 300;

/** Keep what the pixel font can draw, with any whitespace as a plain space, up to the
 * length limit. server/chat.py cleans the same way. Every allowed character is a
 * single UTF-16 unit, so the length is in characters. */
export function cleanChat(text: string): string {
  return [...text.normalize('NFC').replace(/\s/g, ' ')]
    .filter(character => characters.has(character)).join('').slice(0, chat.maxLength);
}

/** Milliseconds a line stays up: longer lines get longer to read. */
export function lineLifetime(text: string): number {
  return Math.min(chat.lifetime.max, chat.lifetime.base + chat.lifetime.perCharacter * text.length);
}

interface Line { id: string; text: string; expires: number; pending: boolean }

export interface Bubble {
  lines: { id: string; text: string; opacity: number }[];
  /** Being typed, shown below the lines; null when nobody is typing. */
  draft: string | null;
}

/** What each speech bubble holds. Times are performance.now() milliseconds. */
export class ChatLog {
  private lines: Record<Side, Line[]> = { left: [], right: [] };
  private drafts: Record<Side, string | null> = { left: null, right: null };

  /** Replace everything with the server's view, after (re)connecting. */
  sync(lines: ChatLine[], drafts: Record<Side, string>, now: number): void {
    this.lines = { left: [], right: [] };
    for (const line of lines) this.add(line, now, false);
    for (const side of ['left', 'right'] as const) this.drafts[side] = drafts[side] || null;
  }

  /** A line the server confirmed. */
  said(line: ChatLine, now: number): void {
    // Our own line was already shown when we sent it, and what we've typed since
    // is our next draft, not the one this line replaced.
    const ours = this.lines[line.side].some(other => other.id === line.id && other.pending);
    this.add(line, now, false);
    if (!ours) this.drafts[line.side] = null;
  }

  /** A line we sent, shown before the server confirms it. */
  pending(side: Side, id: string, text: string, now: number): void {
    this.add({ side, id, text, remaining: lineLifetime(text) }, now, true);
  }

  /** The server refused a line we sent: take it back. Returns whether it was ours. */
  fail(id: string): boolean {
    for (const side of ['left', 'right'] as const) {
      const lines = this.lines[side];
      const index = lines.findIndex(line => line.id === id && line.pending);
      if (index >= 0) {
        lines.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  draft(side: Side, text: string | null): void {
    this.drafts[side] = text;
  }

  bubble(side: Side, now: number): Bubble {
    const lines = this.lines[side] = this.lines[side].filter(line => line.expires > now);
    const draft = this.drafts[side];
    // At most `chat.lines` lines in a bubble, the draft included.
    const shown = lines.slice(Math.max(0, lines.length - (chat.lines - (draft === null ? 0 : 1))));
    return {
      lines: shown.map(({ id, text, expires }) => ({ id, text, opacity: Math.min(1, (expires - now) / fadeTime) })),
      draft,
    };
  }

  private add(line: ChatLine, now: number, pending: boolean): void {
    const lines = this.lines[line.side];
    const entry = { id: line.id, text: line.text, expires: now + line.remaining, pending };
    // Confirming a line we already show keeps its place among lines sent after it.
    const index = lines.findIndex(other => other.id === line.id);
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
    // Keep the confirmed lines the server keeps (its last few), and every line still
    // waiting for it: one the server refuses mustn't have pushed out a good line.
    // bubble() shows only the last few of these.
    const kept = new Set(lines.filter(other => !other.pending).slice(-chat.lines));
    this.lines[line.side] = lines.filter(other => other.pending || kept.has(other));
  }
}
