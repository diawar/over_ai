"""Small deterministic palette of visible logo pixels; no external services."""
from collections import defaultdict
from io import BytesIO
from PIL import Image, UnidentifiedImageError


def logo_palette(data: bytes | None) -> list[str]:
    if not data:
        return []
    try:
        with Image.open(BytesIO(data)) as source:
            image = source.convert("RGBA")
            image.thumbnail((128, 128), Image.Resampling.NEAREST)
            buckets = defaultdict(list)
            for r, g, b, a in image.getdata():
                if a < 192:
                    continue
                buckets[(r // 16, g // 16, b // 16)].append((r, g, b))
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return []
    candidates = []
    for pixels in buckets.values():
        rgb = tuple(round(sum(p[i] for p in pixels) / len(pixels)) for i in range(3))
        candidates.append((len(pixels), rgb))
    # White backgrounds should not crowd out branding colors. Preserve white-only logos.
    foreground = [row for row in candidates if min(row[1]) < 240]
    candidates = foreground or candidates
    colors = []
    for count, rgb in sorted(candidates, reverse=True):
        if colors and count < max(2, sum(row[0] for row in candidates) * .005):
            continue
        if all(sum((a-b)**2 for a, b in zip(rgb, other)) >= 55**2 for other in colors):
            colors.append(rgb)
        if len(colors) == 8:
            break
    return ['#%02X%02X%02X' % color for color in colors]
