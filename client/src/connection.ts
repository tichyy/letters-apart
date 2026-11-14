import type { Message, Side } from './protocol';

export class Connection {
  ready = false;
  side: Side | null = null;
  private socket?: WebSocket;
  private retry?: number;
  private lastMessage = 0;
  private readonly token: string;

  constructor(
    private readonly receive: (message: Message) => void,
    private readonly status: (text: string) => void,
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    this.token = sessionStorage.getItem('letters-token')
      ?? Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('letters-token', this.token);
    // A mobile browser may retain a dead socket after switching networks.
    window.setInterval(() => {
      if (this.ready && Date.now() - this.lastMessage > 5000 && this.side) {
        this.connect(this.side);
      }
    }, 2000);
  }

  connect(side: Side): void {
    clearTimeout(this.retry);
    this.side = side;
    this.ready = false;
    this.status('Connecting…');
    const previous = this.socket;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/${side}?token=${this.token}`);
    this.socket = socket;
    previous?.close();

    socket.onmessage = event => {
      if (socket !== this.socket) return;
      this.lastMessage = Date.now();
      const message = JSON.parse(event.data) as Message;
      if (message.type === 'welcome') {
        this.ready = true;
        sessionStorage.setItem('letters-side', side);
      }
      if (message.type === 'occupied') {
        this.side = null;
        sessionStorage.removeItem('letters-side');
      }
      this.receive(message);
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.ready = false;
      if (this.side) {
        this.status('Reconnecting…');
        this.retry = window.setTimeout(() => this.connect(side), 1500);
      }
    };
    socket.onerror = () => socket.close();
  }

  send(message: object): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }
}
