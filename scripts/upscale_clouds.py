"""Upscale each season's cloud layer 3x with hard pixel edges.

Clouds scroll slower than one screen pixel per frame, so snapping them to whole
pixels makes them step unevenly. The game draws them at fractional positions with
smooth filtering instead. Filtering the original small image would blur every art
pixel across three screen pixels; this copy keeps the blur to a pixel's edge.

    uv run python scripts/upscale_clouds.py

tests/test_cloud_upscale.py fails if a committed copy is out of date.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SCALE = 3


def sources() -> list[Path]:
    return sorted((ROOT / "assets/background").glob("*/Layers/Clouds.png"))


def output(source: Path) -> Path:
    return source.with_name(f"Clouds_{SCALE}x.png")


def upscale(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    return image.resize((image.width * SCALE, image.height * SCALE), Image.Resampling.NEAREST)


if __name__ == "__main__":
    for source in sources():
        upscale(source).save(output(source), optimize=True)
        print(f"Wrote {output(source).relative_to(ROOT)}")
