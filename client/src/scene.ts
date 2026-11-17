import Phaser from 'phaser';
import world from '../../world.json';
import type { Connection } from './connection';
import { Controls } from './controls';
import { move } from './movement';
import { WorldView } from './world-view';
import type { Input, Message, Motion, Player, Side } from './protocol';
import type { UI } from './ui';

const stepTime = 1000 / world.tickRate;

export class WorldScene extends Phaser.Scene {
  private view = new WorldView(this);
  private controls: Controls;
  private players: Player[] = [];
  private pending: Input[] = [];
  private outgoing: Input[] = [];
  private seq = 0;
  private correction = { x: 0, y: 0 };
  private local: Motion = { x: 0, y: 0, vy: 0, jumpChain: 0, landingTicks: 0 };
  private accumulator = 0;
  private active = false;

  constructor(private connection: Connection, private ui: UI) {
    super('world');
    this.controls = new Controls(ui);
  }

  preload(): void {
    this.view.preload(() => this.ui.toast('Some artwork could not load. Please refresh.'));
  }

  create(): void {
    this.view.create(() => this.local.x);
    const detachControls = this.controls.attach(() => this.stop(), () => { this.accumulator = 0; });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, detachControls);
    this.active = true;
  }

  receive(message: Message): void {
    if (message.type !== 'welcome' && message.type !== 'state') return;
    const previous = this.players.length ? {
      x: this.local.x + this.correction.x, y: this.local.y + this.correction.y,
    } : undefined;
    this.players = message.players;
    const own = this.players.find(player => player.side === this.connection.side);
    if (!own) return;
    if (message.type === 'welcome') {
      this.seq = own.ack;
      this.pending = [];
      this.outgoing = [];
      this.local = { ...own };
      this.accumulator = 0;
    } else {
      this.pending = this.pending.filter(input => input.seq > own.ack);
      this.local = this.pending.reduce<Motion>(move, own);
    }
    if (previous) {
      this.correction = { x: previous.x - this.local.x, y: previous.y - this.local.y };
    }
    const partner = this.players.find(player => player.side !== own.side)!;
    this.view.recordPartner(partner, message.type === 'welcome', message.time);
  }

  interact(type: 'interact' | 'gallery' = 'interact'): void {
    if (!this.connection.ready) return;
    const side = this.connection.side!;
    if (type === 'gallery' && !this.nearby(world.desks[side])) return;
    if (![world.desks[side], world.mailboxes.left, world.mailboxes.right].some(x => this.nearby(x))) return;
    this.flush();
    this.connection.send({ type, after: this.seq });
  }

  stop(): void {
    this.controls.release();
    this.accumulator = 0;
    this.flush();
    this.connection.send({ type: 'stop', after: this.seq });
  }

  private flush(): void {
    while (this.outgoing.length) {
      const inputs = this.outgoing.slice(0, 8);
      if (!this.connection.send({ type: 'input', inputs })) return;
      this.outgoing.splice(0, inputs.length);
    }
  }

  update(_time: number, delta: number): void {
    if (!this.active || !this.connection.ready || !this.players.length) {
      this.ui.setHint('');
      this.ui.setGalleryAvailable(false);
      return;
    }
    const direction = this.controls.direction();
    if (this.pending.length >= 120) {
      // Recover from a prolonged stall rather than freezing with growing time debt.
      this.accumulator = 0;
      this.connection.connect(this.connection.side!);
      return;
    }
    this.accumulator += Math.min(delta, 100);
    while (this.accumulator >= stepTime && this.pending.length < 120) {
      this.accumulator -= stepTime;
      const input = { seq: ++this.seq, direction, jump: this.controls.jump() };
      this.pending.push(input);
      this.outgoing.push(input);
      this.local = move(this.local, input);
      if (this.outgoing.length >= 2) this.flush();
    }

    const decay = Math.exp(-Math.min(delta, 100) / 100);
    this.correction.x *= decay;
    this.correction.y *= decay;
    if (Math.abs(this.correction.x) < 0.1) this.correction.x = 0;
    if (Math.abs(this.correction.y) < 0.1) this.correction.y = 0;
    const rendered = { ...this.local, x: this.local.x + this.correction.x, y: Math.min(0, this.local.y + this.correction.y) };
    this.view.renderPlayers(this.players, this.connection.side!, rendered, direction, delta);
    this.view.followPlayer(rendered.x);
    const anchor = this.ui.noticeAnchor;
    if (anchor) {
      const { x, y } = this.view.noticeAnchor(anchor);
      this.ui.positionNotice(x, y);
    }
    this.updateHint();
  }

  private nearby(x: number): boolean {
    return Math.hypot(this.local.x - x, this.local.y) <= world.radius;
  }

  private updateHint(): void {
    const side = this.connection.side!;
    const own = this.players.find(player => player.side === side)!;
    const other = side === 'left' ? 'right' : 'left';
    let hint = '';
    if (this.nearby(world.desks[side]) && !own.carrying) hint = 'E · Write a postcard';
    else if (this.nearby(world.mailboxes[side])) hint = own.unread ? 'E · Read your mail' : 'E · Check your mailbox';
    else if (this.nearby(world.mailboxes[other]) && own.carrying) hint = 'E · Deliver your postcard';
    this.ui.setHint(this.ui.blocked ? '' : hint);
    this.ui.setGalleryAvailable(!this.ui.blocked && this.nearby(world.desks[side]));
  }

  useMailbox(side: Side): void {
    this.view.useMailbox(side);
  }
}
