export type Side = 'left' | 'right';
export type Direction = -1 | 0 | 1;
export type Stamp = 1 | 2 | 3;

export interface Input {
  seq: number;
  direction: Direction;
  jump: boolean;
}

export interface Motion {
  x: number;
  y: number;
  vy: number;
  jumpChain: number;
  landingTicks: number;
}

export interface Player extends Motion {
  side: Side;
  facing: Direction;
  moving: boolean;
  ack: number;
  connected: boolean;
  carrying: boolean;
  unread: number;
}

export type Message =
  | { type: 'welcome'; side: Side; players: Player[] }
  | { type: 'state'; players: Player[] }
  | { type: 'compose' }
  | { type: 'written' }
  | { type: 'postcard'; body: string; date: string; stamp: Stamp }
  | { type: 'mailbox_used'; side: Side }
  | { type: 'delivered'; sender: Side; recipient: Side }
  | { type: 'error'; message: string }
  | { type: 'occupied' };
