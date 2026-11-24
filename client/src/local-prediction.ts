import world from '../../world.json';
import { move } from './movement';
import type { ClientMessage, Direction, Input, Motion, Player } from './protocol';

const stepTime = 1000 / world.tickRate;
// Phaser's default delta smoothing reports at most 1/60 s per frame for 120 frames
// after start and after every return to the tab, so a 30 fps phone ran at half speed
// for ~4 s. The fixed-step simulation needs real elapsed time, and blending between
// steps already keeps uneven frames smooth.
export const frameTiming = { target: world.tickRate, smoothStep: false };
// Matches the server's MAX_BUFFERED_INPUTS: how far prediction may run ahead of it.
const maxPending = 2 * world.tickRate;
// The server accepts at most this many inputs per message.
const batchSize = 8;
// Longest frame simulated at once, so a long pause doesn't replay as one burst.
const maxFrameMs = 100;

export interface Sender { send(message: ClientMessage): boolean }
export interface InputSource { direction(): Direction; jump(): boolean }
export type Frame = { stalled: true } | { stalled: false; pose: Motion };

/**
 * Our own player, predicted ahead of the server one fixed physics step at a time.
 * Every step is sent at once and replayed on top of each authoritative state until
 * the server acknowledges it. The pose to draw blends between the last two steps,
 * and every authority change fades out instead of snapping.
 */
export class LocalPrediction {
  private seq = 0;
  private pending: Input[] = [];
  private outgoing: Input[] = [];
  private local: Motion = { x: 0, y: 0, vy: 0, jumpChain: 0, landingTicks: 0 };
  // The state one step earlier. Frames fall between steps, so draw a blend of both.
  private previous: Motion = this.local;
  private correction = { x: 0, y: 0 };
  private accumulator = 0;
  private reconciled = false;

  constructor(private sender: Sender) {}

  /** The newest predicted state, for deciding what the player can reach. */
  get position(): Motion { return this.local; }

  /**
   * Apply the server's state for our player. `fresh` (a welcome) restarts the input
   * timeline from the server's; otherwise unacknowledged inputs are replayed on it.
   */
  reconcile(own: Player, fresh: boolean): void {
    const before = this.local;
    if (fresh) {
      this.seq = own.ack;
      this.pending = [];
      this.outgoing = [];
      this.local = { ...own };
      this.accumulator = 0;
    } else {
      this.pending = this.pending.filter(input => input.seq > own.ack);
      this.local = this.pending.reduce<Motion>(move, own);
    }
    if (this.reconciled) {
      // Shift the drawn path by the authority's change, then fade that shift out.
      const dx = before.x - this.local.x, dy = before.y - this.local.y;
      this.correction = { x: this.correction.x + dx, y: this.correction.y + dy };
      this.previous = { ...this.previous, x: this.previous.x - dx, y: this.previous.y - dy };
    } else {
      this.previous = this.local;
    }
    this.reconciled = true;
  }

  /**
   * Run the physics steps this frame's time covers and return the pose to draw.
   * Stalled: the server stopped acknowledging; the connection must be rebuilt.
   */
  advance(deltaMs: number, controls: InputSource): Frame {
    // Recover from a prolonged stall by reconnecting, rather than freezing with
    // growing time debt. The reconnect's welcome restarts the clock.
    if (this.pending.length >= maxPending) return { stalled: true };
    const elapsed = Math.min(deltaMs, maxFrameMs);
    const direction = controls.direction();
    this.accumulator += elapsed;
    while (this.accumulator >= stepTime && this.pending.length < maxPending) {
      this.accumulator -= stepTime;
      const input = { seq: ++this.seq, direction, jump: controls.jump() };
      this.pending.push(input);
      this.outgoing.push(input);
      this.previous = this.local;
      this.local = move(this.local, input);
    }
    // Send at once: every frame of batching would delay the partner's view of us.
    this.flush();

    const decay = Math.exp(-elapsed / 100);
    this.correction.x *= decay;
    this.correction.y *= decay;
    if (Math.abs(this.correction.x) < 0.1) this.correction.x = 0;
    if (Math.abs(this.correction.y) < 0.1) this.correction.y = 0;
    // Blend between the last two steps by how far this frame is into the next one.
    const t = Math.min(1, this.accumulator / stepTime);
    const x = this.previous.x + (this.local.x - this.previous.x) * t;
    const y = this.previous.y + (this.local.y - this.previous.y) * t;
    return {
      stalled: false,
      pose: { ...this.local, x: x + this.correction.x, y: Math.min(0, y + this.correction.y) },
    };
  }

  /** Send an action the server must apply after every input predicted so far. */
  sendAfterInputs(type: 'interact' | 'gallery' | 'stop'): void {
    this.flush();
    this.sender.send({ type, after: this.seq });
  }

  /** Stand still where the last predicted step left us. */
  stop(): void {
    this.resetClock();
    this.sendAfterInputs('stop');
  }

  /** Forget time not yet simulated, e.g. while the tab was hidden. */
  resetClock(): void {
    this.accumulator = 0;
  }

  private flush(): void {
    while (this.outgoing.length) {
      const inputs = this.outgoing.slice(0, batchSize);
      if (!this.sender.send({ type: 'input', inputs })) return;
      this.outgoing.splice(0, inputs.length);
    }
  }
}
