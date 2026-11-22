"""The committed 3x cloud layers must match their source images.

After changing a Clouds.png in assets/, regenerate them with:

    uv run python scripts/upscale_clouds.py
"""

import importlib.util
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("upscale_clouds", ROOT / "scripts/upscale_clouds.py")
upscale_clouds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upscale_clouds)


def test_every_season_has_an_up_to_date_upscaled_cloud_layer():
    sources = upscale_clouds.sources()
    assert len(sources) == 4
    for source in sources:
        committed = Image.open(upscale_clouds.output(source)).convert("RGBA")
        assert committed.tobytes() == upscale_clouds.upscale(source).tobytes(), source
