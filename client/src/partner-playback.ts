import world from '../../world.json';
import { move } from './movement';
import type { Direction, Motion, Player } from './protocol';

const stepMs = 1000 / world.tickRate;
// Steps buffered behind the newest data, adapted to how bursty arrival is.
const minDepth = 2;
const maxDepth = 15;
// When data is late, keep the partner running on their last input for this many
// steps, then stand. A fall always continues until they land.
const maxRun = 15;
const maxPredicted = 2 * world.tickRate;
// Beyond this backlog, jump ahead (smoothed) instead of fast-forwarding.
const maxBacklog = 2 * maxDepth;
const correctionMs = 100;
// No faded correction is larger than one backlog jump at top speed. Repeated jumps
// while the tab is hidden (no frames, so no fading) can't pile up into a long glide.
const maxOffset = maxBacklog * world.speed * (1 + (world.maxJumpChain - 1) * world.jumpBoost) / world.tickRate;

export interface Pose extends Motion {
  moving: boolean;
  facing: Direction;
}

/**
 * Plays the partner back on their own physics-step timeline, not on arrival time,
 * so jitter anywhere between their keyboard and this screen lands in one buffer.
 * Late data is covered by continuing their last input with the shared physics, and
 * every timeline change is faded out over ~100 ms instead of snapping.
 */
export class PartnerPlayback {
  private samples: Player[] = [];
  private position = 0;
  private depth = minDepth;
  private offset = { x: 0, y: 0 };
  // Drawn height last frame and landing countdown, so animation follows what is drawn.
  private drawnY = 0;
  private landing = 0;

  push(player: Player, reset: boolean): void {
    const last = this.samples.at(-1);
    if (reset || !last || player.step < last.step) {
      this.samples = [player];
      this.position = player.step;
      this.depth = minDepth;
      this.offset = { x: 0, y: 0 };
      this.drawnY = 0;
      this.landing = 0;
      return;
    }
    if (player.step === last.step) {
      // No new motion, but connection or backpack state may have changed.
      this.correct(() => { this.samples[this.samples.length - 1] = player; });
      return;
    }
    this.correct(() => {
      // A burst of k new steps means they arrived up to k steps late: buffer that much.
      // A bigger burst is a one-off stall, not jitter; the backlog jump covers it.
      const burst = player.step - last.step;
      if (burst <= maxDepth) this.depth = Math.max(this.depth, burst);
      this.samples.push(player);
      // If we were predicting, return to real data at the normal depth now, rather
      // than slowing playback down for seconds to rebuild the buffer.
      if (this.position > last.step) this.position = Math.min(this.position, player.step - this.depth);
      // Too far behind (a long stall, or a hidden tab that stopped rendering): jump ahead.
      if (player.step - this.position > maxBacklog) this.position = player.step - this.depth;
    });
    // Trim here, not only per frame: a hidden tab keeps receiving without rendering.
    this.trim();
  }

  /** Move playback forward and return the pose to draw and animate. */
  advance(deltaMs: number): Pose {
    const latest = this.samples.at(-1);
    if (!latest) throw new Error('No partner state yet.');
    // A resting partner (paused, or just standing) has nothing to predict, so wait
    // at their state; drifting ahead would make them lurch when they set off again.
    const resting = !latest.moving && latest.y === 0 && latest.landingTicks === 0;
    const limit = latest.step + (resting ? 0 : maxPredicted);
    // Play slightly faster or slower to hold the target depth.
    const rate = Math.min(1.5, Math.max(0.75, 1 + (latest.step - this.position - this.depth) * 0.08));
    this.position = Math.min(limit, this.position + deltaMs / stepMs * rate);
    // Shed one step of delay per second once arrival calms down again.
    this.depth = Math.max(minDepth, this.depth - deltaMs / 1000);
    this.trim();

    const decay = Math.exp(-deltaMs / correctionMs);
    this.offset.x = Math.abs(this.offset.x * decay) < 0.01 ? 0 : this.offset.x * decay;
    // Snap the last quarter unit of height so a landing reaches the ground exactly.
    this.offset.y = Math.abs(this.offset.y * decay) < 0.25 ? 0 : this.offset.y * decay;
    const pose = this.pose();
    const y = Math.min(0, pose.y + this.offset.y);
    // Animate the drawn path: while the fade holds them above ground they are
    // falling (the fade's own speed adds to theirs), and touching down is a landing.
    if (y === 0 && this.drawnY < 0) this.landing = world.landingTicks;
    else this.landing = Math.max(0, this.landing - deltaMs / stepMs);
    this.drawnY = y;
    return {
      ...pose,
      x: pose.x + this.offset.x,
      y,
      vy: y < 0 ? pose.vy - this.offset.y * 1000 / correctionMs : 0,
      landingTicks: y < 0 ? 0 : Math.max(pose.landingTicks, this.landing),
    };
  }

  private trim(): void {
    while (this.samples.length > 2 && this.samples[1].step <= this.position) this.samples.shift();
  }

  /** Apply a change to the timeline without a visible jump: fade the difference out. */
  private correct(change: () => void): void {
    const before = this.pose();
    change();
    const after = this.pose();
    const clamp = (value: number) => Math.min(maxOffset, Math.max(-maxOffset, value));
    this.offset.x = clamp(this.offset.x + before.x - after.x);
    this.offset.y = clamp(this.offset.y + before.y - after.y);
  }

  private pose(): Pose {
    const latest = this.samples.at(-1)!;
    if (this.position >= latest.step) return this.predict(latest, this.position - latest.step);
    const i = Math.max(0, this.samples.findIndex(sample => sample.step > this.position) - 1);
    const a = this.samples[i], b = this.samples[i + 1];
    if (this.position <= a.step) return a;
    const t = (this.position - a.step) / (b.step - a.step);
    return {
      ...b,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      landingTicks: a.landingTicks + (b.landingTicks - a.landingTicks) * t,
    };
  }

  /** Continue from the newest state on its last input; never invent a jump. */
  private predict(from: Player, steps: number): Pose {
    const whole = Math.floor(steps);
    const input = (i: number) => ({ seq: 0, direction: from.moving && i < maxRun ? from.facing : 0, jump: false });
    let motion: Motion = from;
    for (let i = 0; i < whole; i++) motion = move(motion, input(i));
    const next = move(motion, input(whole));
    const t = steps - whole;
    return {
      ...motion,
      x: motion.x + (next.x - motion.x) * t,
      y: motion.y + (next.y - motion.y) * t,
      facing: from.facing,
      moving: from.moving && steps < maxRun,
    };
  }
}
