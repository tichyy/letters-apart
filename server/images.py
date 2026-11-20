"""Normalize untrusted photos and store only generated JPEGs outside the webroot."""

import io
import logging
import os
import re
import warnings
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 60_000_000
warnings.filterwarnings("error", category=Image.DecompressionBombWarning)

MAX_UPLOAD = 20 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
IMAGE_ID = re.compile(r"[a-f0-9]{32}")
logger = logging.getLogger(__name__)


class ImageStorage(Protocol):
    """Deletion is idempotent; orphan cleanup must retain every known image ID."""

    def save(self, image_id: str, data: bytes) -> None: ...
    def read(self, image_id: str) -> bytes: ...
    def delete(self, image_id: str) -> None: ...
    def cleanup_orphans(self, known_ids: set[str], older_than: float) -> None: ...


def normalize(data: bytes) -> tuple[bytes, int, int]:
    try:
        with Image.open(
            io.BytesIO(data), formats=["JPEG", "PNG", "WEBP", "HEIF"]
        ) as source:
            if source.width * source.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError("Choose a photo smaller than 60 megapixels.")
            # HEIC and MPO (iPhone JPEGs with depth or portrait data) hold several
            # images, but the first is the photo itself. Other formats animate.
            if source.format not in ("HEIF", "MPO") and getattr(source, "n_frames", 1) != 1:
                raise ValueError("Choose a still photo rather than an animation.")
            # JPEG decoders can downsample during decoding, avoiding a full camera-size raster.
            source.draft("RGB", (1600, 1600))
            source.load()
            ImageOps.exif_transpose(source, in_place=True)
            image = source
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            if image.info.get("icc_profile"):
                try:
                    image = ImageCms.profileToProfile(
                        image,
                        ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"])),
                        ImageCms.createProfile("sRGB"),
                        outputMode="RGBA" if "A" in image.getbands() else "RGB",
                    )
                except (ImageCms.PyCMSError, OSError, ValueError):
                    pass  # A damaged color profile must not be copied into the result.
            rgba = image.convert("RGBA")
            clean = Image.new("RGB", image.size, "#f8ecd4")
            clean.paste(rgba, mask=rgba.getchannel("A"))
            for quality in (85, 75, 65):
                output = io.BytesIO()
                clean.save(output, format="JPEG", quality=quality, optimize=True)
                if output.tell() <= MAX_OUTPUT:
                    return output.getvalue(), clean.width, clean.height
            raise ValueError(
                "This photo is too detailed. Please choose a smaller image."
            )
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise ValueError("Choose a photo smaller than 60 megapixels.") from None
    except (UnidentifiedImageError, OSError, SyntaxError):
        raise ValueError("Choose a valid JPEG, PNG, WebP, or HEIC photo.") from None


class LocalImageStorage:
    """Filesystem implementation of the photo storage contract."""

    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def path(self, image_id: str) -> Path:
        if not IMAGE_ID.fullmatch(image_id):
            raise ValueError("Invalid photo.")
        return self.directory / f"{image_id}.jpg"

    def save(self, image_id: str, data: bytes) -> None:
        path = self.path(image_id)
        temporary = path.with_suffix(".tmp")
        try:
            temporary.write_bytes(data)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def delete(self, image_id: str) -> None:
        self.path(image_id).unlink(missing_ok=True)

    def read(self, image_id: str) -> bytes:
        return self.path(image_id).read_bytes()

    def cleanup_orphans(self, known_ids: set[str], older_than: float) -> None:
        for path in self.directory.iterdir():
            if (
                path.suffix not in (".tmp", ".jpg")
                or not IMAGE_ID.fullmatch(path.stem)
                or path.stem in known_ids
            ):
                continue
            try:
                if path.stat().st_mtime < older_than:
                    path.unlink(missing_ok=True)
            except FileNotFoundError:
                pass  # Another cleanup may already have removed the file.
            except OSError:
                logger.warning(
                    "Could not delete orphan photo %s", path.name, exc_info=True
                )
