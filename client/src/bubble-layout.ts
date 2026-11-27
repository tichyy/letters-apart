import type { Side } from './protocol';

/** A bubble to place: its tail's tip (over the head) and its size, in CSS pixels. */
export interface BubbleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a bubble goes: its top-left corner, and the corner its tail hangs from
 * ('left': the bubble opens to the right of the tip).
 */
export interface Placement {
  left: number;
  top: number;
  tail: Side;
}

export interface LayoutOptions {
  own: Side;
  /** The player is typing: their bubble's last line is the draft. */
  typing: boolean;
  /** The visible area (with a phone keyboard up, only what is above it). */
  width: number;
  height: number;
  /** From the bubble's edge to the tail's tip, and the tail's height. */
  tipInset: number;
  tailHeight: number;
  gap: number;
  /** The corner each bubble's tail hung from last frame, for bubbles still showing. */
  previous?: Partial<Record<Side, Side>>;
}

/** How far the other speaker must be past a player before that player's bubble
 * turns to open away from them, in CSS pixels. Less, and two players standing
 * together would flip their bubbles back and forth as they shuffle. */
const turnDistance = 24;

/** Place the bubbles over the players' heads. Side by side they may overlap; the
 * player's own is drawn on top. */
export function layoutBubbles(boxes: Partial<Record<Side, BubbleBox>>, options: LayoutOptions): Partial<Record<Side, Placement>> {
  const { own, typing, width, height, tipInset, tailHeight, gap, previous = {} } = options;
  const placements: Partial<Record<Side, Placement>> = {};
  const both = boxes.left && boxes.right;
  for (const side of ['left', 'right'] as const) {
    const box = boxes[side];
    if (!box) continue;
    // Open away from the other speaker, so the two bubbles part; alone, open
    // toward the middle of the screen, where there is room. Once open, a bubble
    // keeps its side: the camera follows the player, so their head sits on the
    // middle line, and every pixel the camera snaps would otherwise flip it.
    const other = boxes[side === 'left' ? 'right' : 'left'];
    let tail: Side;
    if (both && (!previous[side] || Math.abs(box.x - other!.x) >= turnDistance)) {
      tail = box.x < other!.x || (box.x === other!.x && side === 'left') ? 'right' : 'left';
    } else {
      tail = previous[side] ?? (box.x > width / 2 ? 'right' : 'left');
    }
    const leftOf = (corner: Side) => corner === 'left' ? box.x - tipInset : box.x + tipInset - box.width;
    // At the screen's edge, turn the other way.
    if (tail === 'left' && leftOf('left') + box.width > width - gap) tail = 'right';
    else if (tail === 'right' && leftOf('right') < gap) tail = 'left';
    const left = Math.max(gap, Math.min(width - box.width - gap, leftOf(tail)));
    // Keep it on screen. When it can't fit, the draft (the bottom line) must stay
    // visible above a phone keyboard; anything else keeps its top in view.
    const above = gap;
    const below = height - gap - box.height;
    let top = box.y - tailHeight - box.height;
    top = side === own && typing ? Math.min(below, Math.max(above, top)) : Math.max(above, Math.min(below, top));
    placements[side] = { left, top, tail };
  }
  return placements;
}
