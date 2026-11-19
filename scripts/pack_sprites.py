"""Pack the game's sprite frames into one texture atlas for Phaser.

One image instead of ~100 means one request and one texture. Frames keep their
original size (no trimming), so sprite origins in world-view.ts stay valid.

    uv run python scripts/pack_sprites.py

tests/test_sprite_atlas.py fails if the committed atlas is out of date.
"""

import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUTPUT = ROOT / "client" / "src" / "sprites"
MAX_WIDTH = 512
PADDING = 1


def sources() -> dict[str, Path]:
    """Frame name -> source image. Names match the texture keys world-view.ts used."""
    frames = {}
    for action, count in (("idle", 2), ("run", 4), ("jump", 7), ("sit", 2)):
        for frame in range(1, count + 1):
            frames[f"dog-{action}-{frame}"] = ASSETS / f"dog/dog_{action}_{frame}.png"
    for side, letter in (("left", "A"), ("right", "B")):
        frames[f"house-{side}"] = ASSETS / f"buildings/house{letter}.png"
        for backpack in (False, True):
            folder = letter + ("withBackpack" if backpack else "")
            for frame in range(1, 20):
                action = (
                    "idle" if frame <= 3 else "run" if frame <= 11
                    else "jump" if frame <= 14 else "fall" if frame <= 16 else "land"
                )
                frames[f"{side}-{str(backpack).lower()}-{frame}"] = (
                    ASSETS / f"player/{folder}/{action}/player{frame}.png"
                )
    for frame in range(1, 7):
        frames[f"mail-{frame}"] = ASSETS / f"mailbox/mailbox-close-anim0{frame}.png"
    return frames


def pack() -> tuple[Image.Image, dict]:
    images = {name: Image.open(path).convert("RGBA") for name, path in sources().items()}
    # Shelf packing, tallest first: simple, and plenty for ~100 small frames.
    order = sorted(images, key=lambda name: (-images[name].height, name))
    placed, x, y, shelf = {}, 0, 0, 0
    for name in order:
        image = images[name]
        if x + image.width > MAX_WIDTH:
            x, y, shelf = 0, y + shelf + PADDING, 0
        placed[name] = (x, y)
        x += image.width + PADDING
        shelf = max(shelf, image.height)
    width = max(placed[name][0] + images[name].width for name in placed)
    height = y + shelf
    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    frames = {}
    for name in sorted(placed):
        (fx, fy), image = placed[name], images[name]
        atlas.paste(image, (fx, fy))
        w, h = image.size
        frames[name] = {
            "frame": {"x": fx, "y": fy, "w": w, "h": h},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
            "sourceSize": {"w": w, "h": h},
        }
    data = {
        "frames": frames,
        "meta": {"image": "sprites.png", "size": {"w": width, "h": height}, "scale": "1"},
    }
    return atlas, data


if __name__ == "__main__":
    atlas, data = pack()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT / "sprites.png", optimize=True)
    (OUTPUT / "sprites.json").write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")
    print(f"Packed {len(data['frames'])} frames into {atlas.width}x{atlas.height}")
