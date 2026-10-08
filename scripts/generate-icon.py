#!/usr/bin/env python3
"""Generate the app icon using only Python's standard library and macOS tools."""
from math import ceil, cos, floor, pi, sin
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
SIZE = 1024
SCALE = 2
W = SIZE * SCALE
pixels = bytearray(W * W * 4)


def rounded_rect(cx, cy, width, height, radius, color, angle=0):
    radians = angle * pi / 180
    c, s = cos(radians), sin(radians)
    half_w, half_h = width / 2, height / 2
    extent_x = abs(half_w * c) + abs(half_h * s)
    extent_y = abs(half_w * s) + abs(half_h * c)
    left, right = max(0, floor((cx - extent_x) * SCALE)), min(W, ceil((cx + extent_x) * SCALE))
    top, bottom = max(0, floor((cy - extent_y) * SCALE)), min(W, ceil((cy + extent_y) * SCALE))
    red, green, blue, alpha = color
    for y in range(top, bottom):
        dy = (y + .5) / SCALE - cy
        for x in range(left, right):
            dx = (x + .5) / SCALE - cx
            local_x, local_y = dx * c + dy * s, -dx * s + dy * c
            qx = abs(local_x) - half_w + radius
            qy = abs(local_y) - half_h + radius
            if max(qx, 0) ** 2 + max(qy, 0) ** 2 > radius ** 2:
                continue
            i = (y * W + x) * 4
            if alpha == 255:
                pixels[i:i + 4] = bytes(color)
            else:
                a = alpha / 255
                previous_alpha = pixels[i + 3] / 255
                combined = a + previous_alpha * (1 - a)
                if combined:
                    pixels[i] = round((red * a + pixels[i] * previous_alpha * (1 - a)) / combined)
                    pixels[i + 1] = round((green * a + pixels[i + 1] * previous_alpha * (1 - a)) / combined)
                    pixels[i + 2] = round((blue * a + pixels[i + 2] * previous_alpha * (1 - a)) / combined)
                    pixels[i + 3] = round(combined * 255)


def on_card(cx, cy, angle, local_x, local_y, width, height, radius, color):
    radians = angle * pi / 180
    c, s = cos(radians), sin(radians)
    rounded_rect(cx + local_x * c - local_y * s, cy + local_x * s + local_y * c, width, height, radius, color, angle)


CREAM = (250, 245, 234, 255)
NAVY = (29, 42, 56, 255)
ORANGE = (239, 113, 63, 255)
WHITE = (255, 250, 241, 255)
rounded_rect(512, 526, 872, 872, 192, (15, 27, 35, 20))
rounded_rect(512, 506, 872, 872, 192, CREAM)

# Back voucher: quiet navy, with a subtle warm cream label.
rounded_rect(493, 437, 608, 360, 42, (15, 27, 35, 28), -13)
rounded_rect(490, 416, 608, 360, 42, NAVY, -13)
on_card(490, 416, -13, -196, -103, 102, 18, 9, (250, 245, 234, 160))
on_card(490, 416, -13, 92, -103, 190, 18, 9, (250, 245, 234, 64))

# Foreground voucher. Rounded inset and clear bars remain legible at Dock sizes.
rounded_rect(534, 600, 608, 360, 42, (15, 27, 35, 30), 8)
rounded_rect(534, 575, 608, 360, 42, ORANGE, 8)
on_card(534, 575, 8, -188, -62, 115, 105, 26, WHITE)
on_card(534, 575, 8, -188, -62, 51, 43, 12, ORANGE)
on_card(534, 575, 8, 81, -78, 233, 28, 14, WHITE)
on_card(534, 575, 8, 44, -26, 159, 20, 10, (255, 250, 241, 170))
on_card(534, 575, 8, -146, 95, 198, 18, 9, (255, 250, 241, 190))
on_card(534, 575, 8, 162, 95, 96, 18, 9, (255, 250, 241, 190))

# Average supersampled pixels in premultiplied space so transparent edges stay clean.
scanlines = bytearray()
for y in range(SIZE):
    scanlines.append(0)
    for x in range(SIZE):
        indexes = [((y * 2 + oy) * W + x * 2 + ox) * 4 for oy in (0, 1) for ox in (0, 1)]
        total_alpha = sum(pixels[i + 3] for i in indexes)
        if total_alpha:
            scanlines.extend(round(sum(pixels[i + channel] * pixels[i + 3] for i in indexes) / total_alpha) for channel in (0, 1, 2))
            scanlines.append(round(total_alpha / 4))
        else:
            scanlines.extend((0, 0, 0, 0))


def chunk(kind, value):
    return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)


OUT.mkdir(exist_ok=True)
png = OUT / "icon.png"
png.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))
if shutil.which("sips") and shutil.which("iconutil"):
    with tempfile.TemporaryDirectory(prefix="gat-icon-") as temporary:
        iconset = Path(temporary) / "app.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                suffix = "@2x" if scale == 2 else ""
                destination = iconset / f"icon_{size}x{size}{suffix}.png"
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale), str(png), "--out", str(destination)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)
print(f"Generated {png} and {OUT / 'icon.icns'}")
