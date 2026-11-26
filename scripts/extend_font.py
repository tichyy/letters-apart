"""Add Czech letters to the m3x6 pixel font (assets/m3x6.ttf -> assets/font.ttf).

m3x6 by Daniel Linssen covers ASCII and part of Latin-1 only. Each Czech letter
is the font's own base letter with a small pixel accent drawn above it, copied
into one plain outline so it needs nothing else from the font at render time.

The font sits on a 64-unit pixel grid. Rows count up from the baseline: lowercase
letters fill rows 0-4, capitals and ascenders rows 0-5, and the ascent leaves
room up to row 9.

    uv run python scripts/extend_font.py

tests/test_font.py fails if the committed font is out of date.
"""

from pathlib import Path

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/m3x6.ttf"
OUTPUT = ROOT / "assets/font.ttf"
PX = 64  # font units per pixel

# Accents as pixel rows, top row first; '#' is a lit pixel.
ACCENTS = {
    "acute": ["..#", ".#."],
    "caron": ["#.#", ".#."],
    "ring": [".#.", "#.#", ".#."],
    "apostrophe": ["#", "#"],
}

# The lowest row an accent may use: one empty row above the letter.
ABOVE_LOWER = 6
ABOVE_UPPER = 7

# Letter -> (base letter, accent, accent's bottom row, accent's left column, advance or None).
LETTERS = {
    **{c: (b, "acute", ABOVE_LOWER, 0, None) for c, b in zip("áéóúý", "aeouy")},
    **{c: (b, "caron", ABOVE_LOWER, 0, None) for c, b in zip("čěňřšž", "cenrsz")},
    "ů": ("u", "ring", ABOVE_LOWER, 0, None),
    # ď and ť take an apostrophe-style caron beside the ascender, as in print.
    "ď": ("d", "apostrophe", 4, 4, 6),
    "ť": ("t", "apostrophe", 4, 3, 5),
    **{c: (b, "acute", ABOVE_UPPER, 0, None) for c, b in zip("ÁÉÍÓÚÝ", "AEIOUY")},
    **{c: (b, "caron", ABOVE_UPPER, 0, None) for c, b in zip("ČĎĚŇŘŠŤŽ", "CDENRSTZ")},
    "Ů": ("U", "ring", ABOVE_UPPER, 0, None),
    # Standalone caron, sitting where the lowercase accents do.
    "ˇ": (None, "caron", ABOVE_LOWER, 0, 4),
}

# í is drawn whole: m3x6's i is one pixel wide with a dot, so the dot gives way to
# a two-pixel acute and the stem grows to the full x-height like the other letters.
DOTLESS_I_ACUTE = [".#", "#.", "..", "#.", "#.", "#.", "#.", "#."]  # top row is row 7


def draw_pixels(pen, rows: list[str], bottom: int, left: int = 0) -> None:
    """Draw pixel rows whose last row sits on row `bottom`, one rectangle per run."""
    for i, row in enumerate(rows):
        y = (bottom + len(rows) - 1 - i) * PX
        x = 0
        while x < len(row):
            if row[x] != "#":
                x += 1
                continue
            end = x
            while end < len(row) and row[end] == "#":
                end += 1
            x0, x1 = (left + x) * PX, (left + end) * PX
            # Clockwise, like the rest of the font's outer contours.
            pen.moveTo((x0, y))
            pen.lineTo((x0, y + PX))
            pen.lineTo((x1, y + PX))
            pen.lineTo((x1, y))
            pen.closePath()
            x = end


def build(source: Path = SOURCE, output: Path = OUTPUT) -> None:
    # Keep the source's timestamp so the same input always gives the same bytes.
    font = TTFont(source, recalcTimestamp=False)
    glyf, hmtx = font["glyf"], font["hmtx"]
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()

    def add(char: str, pen: TTGlyphPen, advance: int) -> None:
        name = f"uni{ord(char):04X}"
        glyph = pen.glyph()
        glyf[name] = glyph
        if name not in order:
            order.append(name)
        glyph.recalcBounds(glyf)
        hmtx[name] = (advance * PX, glyph.xMin)
        for table in font["cmap"].tables:
            if table.isUnicode():
                table.cmap[ord(char)] = name

    for char, (base, accent, bottom, left, advance) in LETTERS.items():
        pen = TTGlyphPen(None)
        if base:
            glyphs[cmap[ord(base)]].draw(pen)
            advance = advance or hmtx[cmap[ord(base)]][0] // PX
        draw_pixels(pen, ACCENTS[accent], bottom, left)
        add(char, pen, advance)

    pen = TTGlyphPen(None)
    draw_pixels(pen, DOTLESS_I_ACUTE, bottom=0)
    add("í", pen, hmtx[cmap[ord("i")]][0] // PX)

    font.setGlyphOrder(order)
    font.save(output)


if __name__ == "__main__":
    import sys

    build(*(Path(arg) for arg in sys.argv[1:3]))
