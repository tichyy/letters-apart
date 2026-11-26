"""The committed game font must be m3x6 extended with Czech letters.

After changing scripts/extend_font.py, regenerate it with:

    uv run python scripts/extend_font.py
"""

import importlib.util
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("extend_font", ROOT / "scripts/extend_font.py")
extend_font = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extend_font)

FONT = ROOT / "assets/font.ttf"
CZECH = "áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽˇ´"


def test_committed_font_is_up_to_date(tmp_path):
    built = tmp_path / "font.ttf"
    extend_font.build(extend_font.SOURCE, built)
    assert built.read_bytes() == FONT.read_bytes()


def test_font_has_every_czech_letter():
    cmap = TTFont(FONT).getBestCmap()
    assert [c for c in CZECH if ord(c) not in cmap] == []


def test_original_glyphs_are_unchanged():
    source, font = TTFont(extend_font.SOURCE), TTFont(FONT)
    for code, name in source.getBestCmap().items():
        assert font.getBestCmap()[code] == name
        before = source["glyf"][name].getCoordinates(source["glyf"])[0]
        assert font["glyf"][name].getCoordinates(font["glyf"])[0] == before, chr(code)
        assert font["hmtx"][name] == source["hmtx"][name], chr(code)


def test_new_letters_stay_on_the_pixel_grid_and_inside_the_line():
    font = TTFont(FONT)
    cmap, glyf = font.getBestCmap(), font["glyf"]
    for char in CZECH:
        glyph = glyf[cmap[ord(char)]]
        assert all(x % 64 == 0 and y % 64 == 0 for x, y in glyph.getCoordinates(glyf)[0]), char
        # Anything above the ascent is cut off by the line box.
        assert glyph.yMax <= font["hhea"].ascent, char
        assert glyph.xMax <= font["hmtx"][cmap[ord(char)]][0], char
