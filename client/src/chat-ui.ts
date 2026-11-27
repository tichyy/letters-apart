import chat from '../../chat.json';
import { paintBubble, tailHeight, tipInset } from './bubble-art';
import { layoutBubbles, type BubbleBox } from './bubble-layout';
import { ChatLog, cleanChat, type Bubble } from './chat';
import { randomId } from './connection';
import type { ClientMessage, Message, Side } from './protocol';

/** Drafts go out at most this often, in milliseconds; the last one always goes. */
const draftInterval = 50;
/** Gap kept between a bubble and the screen edge, in CSS pixels. */
const edgeGap = 8;

export interface BubbleAnchor {
  /** Above the character's head, in CSS pixels. */
  x: number;
  y: number;
}

/**
 * Speech-bubble chat. T (or the chat button) opens a hidden text field: what is typed
 * shows live in the player's own bubble and the partner's, and Enter says it.
 */
export class ChatUI {
  private log = new ChatLog();
  private input: HTMLInputElement;
  private bubbles: Record<Side, HTMLElement>;
  private rendered: Record<Side, string> = { left: '', right: '' };
  private painted: Record<Side, string> = { left: '', right: '' };
  private side?: Side;
  private opened = false;
  /** The draft the server has for us; null when we can't be sure. */
  private sentDraft: string | null = '';
  private lastDraftAt = -Infinity;
  private draftTimer?: number;

  constructor(
    root: HTMLElement,
    private readonly send: (message: ClientMessage) => boolean,
    private readonly changed: () => void,
    /** Touch screens keep the keyboard up after sending, for the next line. */
    private readonly stayOpen: () => boolean,
  ) {
    const layer = document.createElement('div');
    layer.id = 'chat';
    this.bubbles = { left: this.bubble(), right: this.bubble() };
    this.input = Object.assign(document.createElement('input'), {
      id: 'chat-input', type: 'text', maxLength: chat.maxLength, autocomplete: 'off', enterKeyHint: 'send',
    });
    this.input.setAttribute('aria-label', 'Say something');
    this.input.spellcheck = false;
    // Focused only by opening the chat (T or the button), never by Tab.
    this.input.tabIndex = -1;
    layer.append(this.bubbles.left, this.bubbles.right, this.input);
    root.append(layer);

    this.input.addEventListener('input', event => {
      // Cleaning mid-composition (accents, IMEs) would break it; compositionend does it.
      if (!(event as InputEvent).isComposing) this.clean();
      this.updateDraft();
    });
    this.input.addEventListener('compositionend', () => {
      this.clean();
      this.updateDraft();
    });
    this.input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.say();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    // Tapping anywhere else (or switching windows) ends typing.
    this.input.addEventListener('blur', () => this.close());
  }

  get open(): boolean { return this.opened; }

  connected(side: Side): void {
    this.side = side;
  }

  show(): void {
    if (!this.side || this.opened) return;
    this.opened = true;
    this.input.value = '';
    this.log.draft(this.side, '');
    // Synchronously within the key press or tap, or phones won't raise the keyboard.
    this.input.focus({ preventScroll: true });
    this.changed();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.input.value = '';
    this.input.blur();
    if (this.side) this.log.draft(this.side, null);
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.sendDraft('');
    this.changed();
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.show();
  }

  receive(message: Message): void {
    const now = performance.now();
    if (message.type === 'chat') {
      this.log.sync(message.lines, message.drafts, now);
      // The server forgot our draft when we reconnected; send it again.
      this.sentDraft = '';
      if (this.side) this.log.draft(this.side, this.opened ? this.input.value : null);
      if (this.opened) this.updateDraft();
    } else if (message.type === 'said') {
      this.log.said(message.line, now);
    } else if (message.type === 'draft' && message.side !== this.side) {
      this.log.draft(message.side, message.text || null);
    }
  }

  /** A refused line of ours comes back out of the bubble. Returns whether it was one. */
  fail(requestId?: string): boolean {
    if (!requestId || !this.log.fail(requestId)) return false;
    // A refused line doesn't end the draft it came from on the server, so the
    // partner would keep seeing it: send what we're typing now (or nothing).
    this.sentDraft = null;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.sendDraft(this.opened ? this.input.value : '');
    return true;
  }

  /** Each frame: a bubble over each character in view (undefined: not in view). */
  render(anchors: Partial<Record<Side, BubbleAnchor>>): void {
    const now = performance.now();
    const bounds = this.input.parentElement!.getBoundingClientRect();
    // CSS pixels per pixel of the bubble sheet: its 3-pixel lines are one font pixel.
    const sheetPixel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-pixel')) / 3 || 2 / 3;
    const snap = (value: number) => Math.round(value * devicePixelRatio) / devicePixelRatio;
    // First fill each bubble and measure it, then place both together.
    const boxes: Partial<Record<Side, BubbleBox>> = {};
    for (const side of ['left', 'right'] as const) {
      const element = this.bubbles[side];
      const anchor = anchors[side];
      const bubble = this.log.bubble(side, now);
      // Only the one typing sees where their caret is.
      const caret = side === this.side && this.opened ? this.input.selectionStart ?? this.input.value.length : undefined;
      if (!anchor || (!bubble.lines.length && bubble.draft === null)) {
        element.hidden = true;
        continue;
      }
      element.hidden = false;
      this.fill(side, bubble, caret);
      const text = element.lastElementChild!;
      bubble.lines.forEach((line, index) => {
        (text.children[index] as HTMLElement).style.opacity = String(line.opacity);
      });
      boxes[side] = {
        x: anchor.x - bounds.left, y: anchor.y - bounds.top, width: element.offsetWidth, height: element.offsetHeight,
      };
    }
    if (!this.side) return;
    // The layer covers only the visible area, so with a phone keyboard up its bottom
    // is the keyboard's top.
    const placements = layoutBubbles(boxes, {
      own: this.side, typing: this.opened, width: bounds.width, height: bounds.height,
      tipInset: tipInset * sheetPixel, tailHeight: tailHeight * sheetPixel, gap: edgeGap,
    });
    for (const side of ['left', 'right'] as const) {
      const placement = placements[side];
      if (!placement) continue;
      const element = this.bubbles[side];
      // What you type must never be hidden behind your partner's bubble.
      element.style.zIndex = side === this.side ? '1' : '';
      element.style.left = `${snap(placement.left)}px`;
      element.style.top = `${snap(placement.top)}px`;
      this.paint(side, placement.tail);
    }
  }

  private bubble(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'chat-bubble';
    element.hidden = true;
    element.append(document.createElement('canvas'), document.createElement('div'));
    return element;
  }

  /** Repaint a bubble's art when its size or tail changes, at device resolution. */
  private paint(side: Side, tail: Side | null): void {
    const element = this.bubbles[side];
    const canvas = element.firstElementChild as HTMLCanvasElement;
    const bounds = element.getBoundingClientRect();
    const ratio = devicePixelRatio;
    const width = Math.round(bounds.width * ratio);
    const height = Math.round(bounds.height * ratio);
    // Font pixels are whole device pixels (viewport.ts).
    const unit = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-pixel')) * ratio) || 2;
    const key = `${width}:${height}:${unit}:${tail}`;
    if (key === this.painted[side]) return;
    this.painted[side] = key;
    paintBubble(canvas, width, height, unit, tail);
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
  }

  /** Rebuild a bubble's lines only when what it says changes. */
  private fill(side: Side, bubble: Bubble, caret?: number): void {
    const key = JSON.stringify([bubble.lines.map(line => [line.id, line.text]), bubble.draft, caret]);
    if (key === this.rendered[side]) return;
    this.rendered[side] = key;
    const element = this.bubbles[side].lastElementChild!;
    element.replaceChildren(...bubble.lines.map(line => this.line(line.text)));
    if (bubble.draft !== null) {
      const draft = this.line(bubble.draft);
      draft.classList.add('chat-draft');
      if (caret !== undefined) {
        // Marked like the postcard's: a faint block over the letter after the caret,
        // or a space's width at the end. (Every allowed letter is one UTF-16 unit.)
        const mark = document.createElement('span');
        mark.className = 'chat-caret';
        mark.textContent = bubble.draft[caret] ?? '\u00a0';
        draft.replaceChildren(bubble.draft.slice(0, caret), mark, bubble.draft.slice(caret + 1));
      }
      element.append(draft);
    }
  }

  private line(text: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'chat-line';
    element.textContent = text;
    return element;
  }

  /** Drop what the font can't draw, keeping the caret where it was. */
  private clean(): void {
    const { value, selectionStart } = this.input;
    const cleaned = cleanChat(value);
    if (cleaned === value) return;
    const caret = cleanChat(value.slice(0, selectionStart ?? value.length)).length;
    this.input.value = cleaned;
    this.input.setSelectionRange(caret, caret);
  }

  private updateDraft(): void {
    if (!this.side || !this.opened) return;
    this.log.draft(this.side, this.input.value);
    if (this.draftTimer !== undefined) return;
    const wait = this.lastDraftAt + draftInterval - performance.now();
    if (wait <= 0) this.sendDraft(this.input.value);
    else this.draftTimer = window.setTimeout(() => {
      this.draftTimer = undefined;
      if (this.opened) this.sendDraft(this.input.value);
    }, wait);
  }

  private sendDraft(text: string): void {
    if (text === this.sentDraft) return;
    if (this.send({ type: 'draft', text })) {
      this.sentDraft = text;
      this.lastDraftAt = performance.now();
    }
  }

  private say(): void {
    const text = this.input.value.trim();
    if (!text || !this.side) {
      if (!this.stayOpen()) this.close();
      return;
    }
    const requestId = randomId();
    // Offline, the line stays in the field to send once the connection is back.
    if (!this.send({ type: 'say', requestId, text })) return;
    this.log.pending(this.side, requestId, text, performance.now());
    // Saying a line ends its draft on the server too.
    this.sentDraft = '';
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.input.value = '';
    this.log.draft(this.side, '');
    if (!this.stayOpen()) this.close();
  }
}
