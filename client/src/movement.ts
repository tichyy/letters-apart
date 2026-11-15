import Phaser from 'phaser';
import world from '../../world.json';
import type { Input, Motion } from './protocol';

export function move(state: Motion, input: Input): Motion {
  let { vy, jumpChain, landingTicks } = state;
  if (state.y === 0) {
    if (!input.jump) jumpChain = 0;
    landingTicks = Math.max(0, landingTicks - 1);
    if (input.jump && landingTicks === 0) {
      vy = -world.jumpSpeed;
      jumpChain = Math.min(jumpChain + 1, world.maxJumpChain);
    }
  }
  vy += world.gravity / world.tickRate;
  const y = Math.min(0, state.y + vy / world.tickRate);
  if (state.y < 0 && y === 0) landingTicks = world.landingTicks;
  const speed = world.speed * (1 + Math.max(0, jumpChain - 1) * world.jumpBoost);
  return {
    x: Phaser.Math.Clamp(state.x + input.direction * speed / world.tickRate, world.minX, world.maxX),
    y, vy: y === 0 ? 0 : vy, jumpChain, landingTicks,
  };
}
