import Phaser from 'phaser';
import { Connection } from './connection';
import { WorldScene } from './scene';
import { frameTiming } from './local-prediction';
import { UI } from './ui';
import { faviconUrl, fontUrl, preloadArt } from './art';
import { prepareBubbleArt } from './bubble-art';
import type { Message } from './protocol';
import world from '../../world.json';
import './style.css';

// Imported like all art: an index.html link can't reach ../assets in development.
document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/png', href: faviconUrl }));

// iOS Safari ignores the viewport's user-scalable=no for pinches, so stop its
// pinch gesture here: once zoomed in a dialog, the game itself cannot zoom out.
document.addEventListener('gesturestart', event => event.preventDefault());
// Chrome and Edge send a trackpad pinch as a wheel event with ctrlKey. Phaser already
// cancels wheel events on the canvas, so without this a pinch zoomed the page only
// over dialogs. Ctrl +/− and the browser menu still zoom; the photo editor still gets
// the event and zooms the photo.
document.addEventListener('wheel', event => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false });

// Font and interface art are ready before anything is shown, so no screen fills in
// piece by piece the first time it opens.
const font = new FontFace('GameFont', `url("${fontUrl}")`);
await Promise.all([
  font.load()
    .then(font => document.fonts.add(font))
    .catch(error => console.warn('Font failed to load', error)),
  preloadArt(),
  prepareBubbleArt().catch(error => console.warn('Speech bubbles failed to load', error)),
]);

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
  fps: frameTiming,
  audio: { noAudio: true },
});

function receive(message: Message): void {
  scene.receive(message);
  switch (message.type) {
    case 'welcome': ui.connected(message.side); break;
    case 'compose': ui.compose(message); break;
    case 'written': ui.written(message.requestId); break;
    case 'dropped': ui.toast('Postcard dropped. Your bag is empty again.'); break;
    case 'mailbox': ui.read(message.postcards); break;
    case 'gallery': ui.gallery(message.postcards, message.page, message.hasMore); break;
    case 'occupied': ui.chooseHome(true); break;
    case 'replaced': ui.replaced(message.side); break;
    case 'error': ui.error(message.message, message.requestId); break;
    case 'chat': case 'said': case 'draft': ui.chat.receive(message); break;
    case 'mailbox_used': scene.useMailbox(message.side); break;
    case 'delivered':
      if (message.sender === connection.side) {
        ui.toast('Delivered. A little piece of you, safely on the other side.', { x: world.mailboxes[message.recipient], y: 0 });
      } else {
        ui.toast('A postcard arrived in your mailbox.');
      }
      break;
  }
}

const home = new URLSearchParams(location.search).get('player') ?? sessionStorage.getItem('letters-side');
if (home === 'left' || home === 'right') connection.connect(home);
else ui.chooseHome();
