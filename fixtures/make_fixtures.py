#!/usr/bin/env python3
"""Generate test photos for findmygeo.

Writes six 1200x900 JPEGs next to this script plus fixtures.json describing
each file's expected GPS (or null) and EXIF orientation.

Requires Pillow and piexif:  pip install pillow piexif
"""

import json
import os
from fractions import Fraction
from pathlib import Path

import piexif
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
W, H = 1200, 900
INK = (11, 11, 11)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

# name, fill colour, label, gps (lat, lng) or None, EXIF orientation
FIXTURES = [
    ("photo_a_vancouver.jpg", (250, 103, 103), "PHOTO A", (49.2827, -123.1207), 1),
    ("photo_b_paris.jpg",     (181, 176, 242), "PHOTO B", (48.8584, 2.2945), 1),
    ("photo_c_tokyo.jpg",     (250, 206, 5),   "PHOTO C", (35.6586, 139.7454), 1),
    ("photo_d_sydney.jpg",    (127, 200, 169), "PHOTO D", (-33.8568, 151.2153), 1),
    ("photo_e_no_gps.jpg",    (142, 195, 217), "PHOTO E", None, 1),
    ("photo_f_banff_rot.jpg", (240, 168, 203), "PHOTO F", (51.1784, -115.5708), 6),
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def draw_image(fill, label, orientation):
    img = Image.new("RGB", (W, H), fill)
    d = ImageDraw.Draw(img)
    # Thick ink frame so the edges are obvious in screenshots.
    d.rectangle([0, 0, W - 1, H - 1], outline=INK, width=24)
    # Big label, centred.
    font = load_font(200)
    bbox = d.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((W - tw) / 2 - bbox[0], (H - th) / 2 - bbox[1]), label, font=font, fill=INK)
    # Small "TOP" marker in the top-left corner of the stored pixels, so the
    # orientation tag is visible: after rotation it should land elsewhere.
    d.polygon([(60, 60), (160, 60), (110, 150)], fill=INK)
    small = load_font(48)
    d.text((180, 62), "TOP", font=small, fill=INK)
    return img


def to_dms_rational(value):
    """Decimal degrees -> ((deg,1),(min,1),(sec*1e6,1e6)) for EXIF GPS tags."""
    v = abs(value)
    deg = int(v)
    minutes_full = (v - deg) * 60
    minute = int(minutes_full)
    seconds = (minutes_full - minute) * 60
    sec_num = round(seconds * 1_000_000)
    return ((deg, 1), (minute, 1), (sec_num, 1_000_000))


def build_exif(gps, orientation):
    zeroth = {piexif.ImageIFD.Orientation: orientation}
    exif = {"0th": zeroth, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
    if gps is not None:
        lat, lng = gps
        exif["GPS"] = {
            piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
            piexif.GPSIFD.GPSLatitudeRef: b"N" if lat >= 0 else b"S",
            piexif.GPSIFD.GPSLatitude: to_dms_rational(lat),
            piexif.GPSIFD.GPSLongitudeRef: b"E" if lng >= 0 else b"W",
            piexif.GPSIFD.GPSLongitude: to_dms_rational(lng),
        }
    return piexif.dump(exif)


def main():
    manifest = {}
    for name, fill, label, gps, orientation in FIXTURES:
        img = draw_image(fill, label, orientation)
        out = HERE / name
        img.save(out, "JPEG", quality=92, exif=build_exif(gps, orientation))
        manifest[name] = {
            "gps": None if gps is None else {"lat": gps[0], "lng": gps[1]},
            "orientation": orientation,
        }
        print(f"wrote {out.name}  gps={gps}  orientation={orientation}")

    with open(HERE / "fixtures.json", "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"wrote {HERE / 'fixtures.json'}")


if __name__ == "__main__":
    main()
