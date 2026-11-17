import type { Direction } from './protocol';

interface Owner { x: number; y: number }
interface World { width: number; speed: number; gravity: number; jumpSpeed: number; landingTicks: number; tickRate: number }

const followDistance = 52;
const resumeDistance = 72;
const reactionDelay = 0.16;
const acceleration = 700;

export class DogFollower {
  x: number;
  y = 0;
  vy = 0;
  landingTicks = 0;
  private velocity = 0;
  private direction: Direction;
  private waiting = false;
  private following = false;
  private reaction = 0;
  private sitReaction = 0;
  private turnReaction = 0;
  private flipX: boolean;
  private previousOwnerY = 0;
  private jumpDelay: number | undefined;

  constructor(ownerX: number, direction: Direction, private world: World) {
    this.direction = direction || 1;
    this.flipX = this.direction === -1;
    this.x = this.clamp(ownerX - this.direction * followDistance);
  }

  get jumpSpeed(): number { return this.world.jumpSpeed * 0.85; }

  update(owner: Owner, direction: Direction, connected: boolean, seconds: number) {
    const dt = Math.max(0, Math.min(seconds, 0.05));
    const gap = owner.x - this.x;
    if (direction) this.direction = direction;
    const behind = gap * this.direction;

    if (!connected || (direction && gap * direction <= 0)) {
      this.waiting = connected;
      this.following = false;
      this.reaction = 0;
      this.velocity = 0;
    } else if (this.waiting && behind >= resumeDistance) {
      this.waiting = false;
    }

    if (connected && !this.waiting && !this.following) {
      this.reaction = behind >= resumeDistance ? this.reaction + dt : 0;
      if (this.reaction >= reactionDelay) this.following = true;
    }

    const remaining = Math.max(0, behind - followDistance);
    if (this.following) {
      const desired = this.direction * Math.min(this.world.speed, Math.sqrt(2 * acceleration * remaining));
      this.velocity += Math.max(-acceleration * dt, Math.min(acceleration * dt, desired - this.velocity));
      const distance = Math.min(Math.abs(this.velocity) * dt, remaining);
      this.x = this.clamp(this.x + this.direction * distance);
      if (remaining <= 0.5) {
        this.following = false;
        this.velocity = 0;
        this.reaction = 0;
      }
    }

    if (owner.y < 0 && this.previousOwnerY === 0 && !this.waiting && connected) this.jumpDelay = reactionDelay;
    this.previousOwnerY = owner.y;
    if (this.waiting || !connected) this.jumpDelay = undefined;
    if (this.jumpDelay !== undefined) {
      this.jumpDelay -= dt;
      if (this.jumpDelay <= 0 && this.y === 0 && this.landingTicks === 0) {
        this.vy = -this.jumpSpeed;
        this.jumpDelay = undefined;
      }
    }
    this.landingTicks = Math.max(0, this.landingTicks - dt * this.world.tickRate);
    if (this.y < 0 || this.vy < 0) {
      this.vy += this.world.gravity * dt;
      this.y = Math.min(0, this.y + this.vy * dt);
      if (this.y === 0) {
        this.vy = 0;
        this.landingTicks = this.world.landingTicks;
      }
    }

    const moving = this.following && Math.abs(this.velocity) > 1 && remaining > 0.5;
    this.sitReaction = this.waiting ? this.sitReaction + dt : 0;
    const lookLeft = owner.x < this.x;
    this.turnReaction = lookLeft !== this.flipX ? this.turnReaction + dt : 0;
    if (this.turnReaction >= reactionDelay) {
      this.flipX = lookLeft;
      this.turnReaction = 0;
    }
    return {
      x: this.x, y: this.y, vy: this.vy, landingTicks: this.landingTicks,
      moving, sitting: this.waiting && this.sitReaction >= reactionDelay,
      flipX: this.flipX,
    };
  }

  private clamp(x: number): number { return Math.max(24, Math.min(this.world.width - 24, x)); }
}
