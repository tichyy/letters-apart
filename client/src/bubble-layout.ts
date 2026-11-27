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
 * ('left': the bubble opens to the right of the tip). No tail: it was moved out of
 * the way, and the tail would point at the wrong bubble.
 */
export interface Placement {
  left: number;
  top: number;
  tail: Side | null;
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
}

/** Place the bubbles over the players' heads, so that neither covers the other. */
export function layoutBubbles(boxes: Partial<Record<Side, BubbleBox>>, options: LayoutOptions): Partial<Record<Side, Placement>> {
  const { own, typing, width, height, tipInset, tailHeight, gap } = options;
  const partner: Side = own === 'left' ? 'right' : 'left';
  const placements: Partial<Record<Side, Placement>> = {};
  const both = boxes.left && boxes.right;
  for (const side of ['left', 'right'] as const) {
    const box = boxes[side];
    if (!box) continue;
    // Open away from the other speaker, so the two bubbles part; alone, open
    // toward the middle of the screen, where there is room.
    const other = boxes[side === 'left' ? 'right' : 'left'];
    const westward = both
      ? box.x < other!.x || (box.x === other!.x && side === 'left')
      : box.x > width / 2;
    let tail: Side = westward ? 'right' : 'left';
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
  // Still in each other's way (side by side on a narrow screen): lift the partner's
  // bubble above ours. Ours stays put: it is where the player looks while typing.
  const mine = placements[own];
  const theirs = placements[partner];
  if (mine && theirs && overlaps(mine, boxes[own]!, theirs, boxes[partner]!, gap)) {
    theirs.top = Math.max(gap, mine.top - gap - boxes[partner]!.height);
    theirs.tail = null;
  }
  return placements;
}

function overlaps(a: Placement, aBox: BubbleBox, b: Placement, bBox: BubbleBox, gap: number): boolean {
  return a.left < b.left + bBox.width + gap && b.left < a.left + aBox.width + gap
    && a.top < b.top + bBox.height + gap && b.top < a.top + aBox.height + gap;
}
