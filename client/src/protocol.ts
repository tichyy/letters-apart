export type Side = 'left' | 'right';
export type Direction = -1 | 0 | 1;
export type Stamp = 1 | 2 | 3;

export interface Crop { x: number; y: number; zoom: number }
export interface UploadedPhoto { id: string; width: number; height: number; expiresAt?: number }
export interface Photo extends UploadedPhoto { crop: Crop }

export interface Postcard {
  id: number;
  title: string;
  body: string;
  to: string;
  from: string;
  // When it was written: UTC, as 'YYYY-MM-DD HH:MM:SS'.
  date: string;
  stamp: Stamp;
  image: Photo | null;
}

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
  // Physics steps the server has applied to this player: the partner playback clock.
  step: number;
  connected: boolean;
  carrying: boolean;
  unread: number;
}

export interface WriteRequest {
  type: 'write';
  requestId: string;
  title: string;
  body: string;
  stamp: Stamp;
  to: string;
  from: string;
  imageId: string | null;
  crop: Crop;
}

/** Everything the client sends over the game socket, after its 'hello'. */
export type ClientMessage =
  | { type: 'input'; inputs: Input[] }
  // `after`: the last input sent before it, so the server acts where the player stood.
  | { type: 'interact' | 'gallery' | 'stop'; after: number }
  // Turning a page of the gallery that is already open.
  | { type: 'gallery'; page: number }
  | { type: 'delete'; id: number; page: number }
  | { type: 'read'; id: number }
  | { type: 'drop' }
  | WriteRequest;

export type Message =
  | { type: 'welcome'; side: Side; players: Player[] }
  | { type: 'state'; players: Player[] }
  // The names on this home's last postcard, to start the next one with.
  | { type: 'compose'; to: string; from: string }
  | { type: 'written'; requestId?: string }
  | { type: 'dropped' }
  | { type: 'mailbox'; postcards: Postcard[] }
  | { type: 'gallery'; postcards: Postcard[]; page: number; hasMore: boolean }
  | { type: 'mailbox_used'; side: Side }
  | { type: 'delivered'; sender: Side; recipient: Side }
  | { type: 'error'; message: string; requestId?: string }
  | { type: 'occupied' }
  // Raised by Connection, not the server: this home was opened in another window.
  | { type: 'replaced'; side: Side };
