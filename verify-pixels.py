#!/usr/bin/env python3
"""
Objective pixel check for theme correctness. Human eyeballing of a rendered
screenshot preview turned out to be unreliable during development (a
genuinely dark chat panel was misread as white by visual inspection of the
same PNG that this script correctly reads as dark) — so this exists as the
actual source of truth for "did the theme apply", not a human glance.

Usage: python3 verify-pixels.py artifacts/electron-full-dark-draw-and-ask.png
"""
import sys
from PIL import Image

# Sample points chosen to land inside canvas area and chat panel area for
# the default 1400x860 window layout used by run-visual-proof.mjs.
SAMPLE_POINTS = {
    'canvas_area': (300, 400),
    'chat_area': (1100, 300),
}

DARK_MAX_CHANNEL = 60   # dark theme backgrounds should be well below this
LIGHT_MIN_CHANNEL = 200  # light theme backgrounds should be well above this


def main():
    if len(sys.argv) != 2:
        print('Usage: verify-pixels.py <path-to-png>')
        sys.exit(2)

    path = sys.argv[1]
    is_dark = 'dark' in path
    img = Image.open(path).convert('RGB')

    ok = True
    for label, point in SAMPLE_POINTS.items():
        r, g, b = img.getpixel(point)
        avg = (r + g + b) / 3
        expected = 'dark' if is_dark else 'light'
        passed = avg <= DARK_MAX_CHANNEL if is_dark else avg >= LIGHT_MIN_CHANNEL
        status = 'PASS' if passed else 'FAIL'
        print(f'{status}: {label} at {point} = rgb({r},{g},{b}) avg={avg:.0f}, expected {expected}')
        ok = ok and passed

    print('ALL PIXEL CHECKS PASSED' if ok else 'PIXEL CHECK FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
