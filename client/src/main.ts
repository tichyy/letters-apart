import Phaser from 'phaser';
import { Connection } from './connection';
import { WorldScene } from './scene';
import { UI } from './ui';
import type { Message, Side } from './protocol';
import world from '../../world.json';
import './style.css';

const font = new FontFace('GameFont', 'url("/font.ttf")');
await font.load()
  .then(font => document.fonts.add(font))
  .catch(error => console.warn('Font failed to load', error));

const connection = new Connection(receive, () => ui.disconnected());
const ui = new UI(message => connection.send(message), side => connection.connect(side), action => scene.interact(action), connection);
const scene = new WorldScene(connection, ui);

new Phaser.Game({
  // This small sprite scene needs no shaders; Canvas also avoids slow software WebGL.
  type: Phaser.CANVAS,
  parent: 'game',
  backgroundColor: '#143f5b',
  pixelArt: true,
  roundPixels: true,
  scale: { mode: Phaser.Scale.NONE, width: window.innerWidth, height: window.innerHeight },
  scene,
  fps: { target: 60 },
  audio: { noAudio: true },
});

function receive(message: Message): void {
  scene.receive(message);
  switch (message.type) {
    case 'welcome': ui.connected(message.side); break;
    case 'compose': ui.compose(); break;
    case 'written': ui.written(message.requestId); break;
    case 'mailbox': ui.read(message.postcards); break;
    case 'gallery': ui.gallery(message.postcards, message.page, message.hasMore); break;
    case 'occupied': ui.chooseHome(true); break;
    case 'error': ui.error(message.message, message.requestId); break;
    case 'mailbox_used': scene.useMailbox(message.side); break;
    case 'delivered':
      ui.toast(message.sender === connection.side
        ? 'Delivered. A little piece of you, safely on the other side.'
        : 'A postcard arrived in your mailbox.',
      message.sender === connection.side ? { x: world.mailboxes[message.recipient], y: 0 } : undefined);
      break;
  }
}

const home = new URLSearchParams(location.search).get('player') ?? sessionStorage.getItem('letters-side');
if (home === 'left' || home === 'right') connection.connect(home as Side);
else ui.chooseHome();
