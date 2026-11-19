"""The committed sprite atlas must match its source frames.

After changing a sprite in assets/, regenerate it with:

    uv run python scripts/pack_sprites.py
"""

import importlib.util
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("pack_sprites", ROOT / "scripts/pack_sprites.py")
pack_sprites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack_sprites)

ATLAS = ROOT / "client/src/sprites"


def same_pixels(a: Image.Image, b: Image.Image) -> bool:
    # Raw bytes: getbbox() on an RGBA difference only looks at the alpha channel.
    return a.mode == b.mode and a.size == b.size and a.tobytes() == b.tobytes()


def test_committed_atlas_is_up_to_date():
    atlas, data = pack_sprites.pack()
    assert json.loads((ATLAS / "sprites.json").read_text()) == data
    assert same_pixels(Image.open(ATLAS / "sprites.png").convert("RGBA"), atlas)


def test_every_frame_is_its_source_image_unchanged():
    atlas = Image.open(ATLAS / "sprites.png").convert("RGBA")
    frames = json.loads((ATLAS / "sprites.json").read_text())["frames"]
    sources = pack_sprites.sources()
    assert set(frames) == set(sources)
    for name, path in sources.items():
        box = frames[name]["frame"]
        cut = atlas.crop((box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"]))
        assert same_pixels(cut, Image.open(path).convert("RGBA")), name


def test_frames_do_not_overlap():
    boxes = [f["frame"] for f in json.loads((ATLAS / "sprites.json").read_text())["frames"].values()]
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            apart = (
                a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"]
                or a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"]
            )
            assert apart, (a, b)


def test_comparison_sees_colour_changes_not_only_transparency():
    red = Image.new("RGBA", (2, 2), (255, 0, 0, 255))
    green = Image.new("RGBA", (2, 2), (0, 255, 0, 255))
    faint = Image.new("RGBA", (2, 2), (255, 0, 0, 254))
    assert not same_pixels(red, green)
    assert not same_pixels(red, faint)
    assert same_pixels(red, red.copy())
