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
  private interaction: { seq: number; type: 'interact' | 'gallery' } | null = null;
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
    this.players = message.players;
    const own = this.players.find(player => player.side === this.connection.side);
    if (!own) return;
    if (message.type === 'welcome') {
      this.seq = own.ack;
      this.interaction = null;
      this.pending = [];
      this.outgoing = [];
      this.local = { ...own };
      this.accumulator = 0;
    } else {
      this.pending = this.pending.filter(input => input.seq > own.ack);
      this.local = this.pending.reduce<Motion>(move, own);
    }
    // Interact only after the server has applied the movement already shown locally.
    if (this.interaction !== null && own.ack >= this.interaction.seq) {
      const type = this.interaction.type;
      this.interaction = null;
      this.connection.send({ type });
    }
    const partner = this.players.find(player => player.side !== own.side)!;
    this.view.recordPartner(partner, message.type === 'welcome');
  }

  interact(type: 'interact' | 'gallery' = 'interact'): void {
    if (!this.connection.ready || this.interaction !== null) return;
    const side = this.connection.side!;
    if (type === 'gallery' && !this.nearby(world.desks[side])) return;
    if (![world.desks[side], world.mailboxes.left, world.mailboxes.right].some(x => this.nearby(x))) return;
    this.flush();
    this.interaction = { seq: this.seq, type };
  }

  stop(): void {
    this.interaction = null;
    this.controls.release();
    this.flush();
    this.connection.send({ type: 'stop' });
  }

  private flush(): void {
    if (this.outgoing.length && this.connection.send({ type: 'input', inputs: this.outgoing })) {
      this.outgoing = [];
    }
  }

  update(_time: number, delta: number): void {
    if (!this.active || !this.connection.ready || !this.players.length) {
      this.ui.setHint('');
      this.ui.setGalleryAvailable(false);
      return;
    }
    const direction = this.controls.direction();
    this.accumulator += Math.min(delta, 100);
    while (this.accumulator >= stepTime && this.pending.length < 120) {
      this.accumulator -= stepTime;
      const input = { seq: ++this.seq, direction, jump: this.controls.jump() };
      this.pending.push(input);
      this.outgoing.push(input);
      this.local = move(this.local, input);
      if (this.outgoing.length >= 2) this.flush();
    }

    this.view.renderPlayers(this.players, this.connection.side!, this.local, direction, delta);
    this.view.followPlayer(this.local.x);
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
