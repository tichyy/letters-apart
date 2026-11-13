import Phaser from 'phaser';
import { Connection } from './connection';
import { WorldScene } from './scene';
import { UI } from './ui';
import type { Message, Side } from './protocol';
import './style.css';

const ui = new UI(message => connection.send(message), side => connection.connect(side), () => scene.interact());
const connection = new Connection(receive, status => ui.disconnected(status));
const scene = new WorldScene(connection, ui);

new Phaser.Game({
  // This small sprite scene needs no shaders; Canvas also avoids slow software WebGL.
  type: Phaser.CANVAS,
  parent: 'game',
  backgroundColor: '#143f5b',
  pixelArt: true,
  roundPixels: true,
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene,
  fps: { target: 60 },
  audio: { noAudio: true },
});

function receive(message: Message): void {
  scene.receive(message);
  switch (message.type) {
    case 'compose': ui.compose(); break;
    case 'written': ui.written(); break;
    case 'postcard': ui.read(message.body, message.date); break;
    case 'occupied': ui.chooseHome(true); break;
    case 'error': ui.error(message.message); break;
    case 'mailbox_used': scene.useMailbox(message.side); break;
    case 'delivered':
      ui.toast(message.sender === connection.side
        ? 'Delivered. A little piece of you, safely on the other side.'
        : 'A postcard arrived in your mailbox.');
      break;
  }
}

const home = new URLSearchParams(location.search).get('player') ?? sessionStorage.getItem('letters-side');
if (home === 'left' || home === 'right') connection.connect(home as Side);
else ui.chooseHome();
