"""Generate every Notidea icon and design asset from one path definition."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets'
PUB = ROOT / 'public'
DESIGN = ROOT / 'design' / 'notidea'
IRIS = '#6255D9'
STROKE = 64
RADIUS = 116
# 512-unit centerline; round caps leave a 44-unit visible interruption.
SEGMENTS = (
    ('M', 120, 380), ('V', 220),
    ('C', 120, 84, 392, 84, 392, 220),
    ('M', 392, 328), ('V', 380),
)
PATH = ''.join(command + ' '.join(map(str, values)) for command, *values in SEGMENTS)
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def mark_points():
    """Sample the very same commands exported to SVG, at sub-unit spacing."""
    sections = []
    current = None
    for command, *values in SEGMENTS:
        if command == 'M':
            current = tuple(values)
            sections.append([current])
        elif command == 'V':
            end = (current[0], values[0])
            steps = max(1, math.ceil(abs(end[1] - current[1]) * 2))
            sections[-1].extend((current[0], current[1] + (end[1] - current[1]) * i / steps)
                                for i in range(1, steps + 1))
            current = end
        elif command == 'C':
            start = current
            x1, y1, x2, y2, x3, y3 = values
            for i in range(1, 1025):
                t = i / 1024
                u = 1 - t
                sections[-1].append((u**3 * start[0] + 3*u*u*t*x1 + 3*u*t*t*x2 + t**3*x3,
                                     u**3 * start[1] + 3*u*u*t*y1 + 3*u*t*t*y2 + t**3*y3))
            current = (x3, y3)
    return sections


def render(size=1024, bg=IRIS, color='#FFFFFF'):
    # Render each small size directly rather than repeatedly downsampling.
    supersample = 4
    side = size * supersample
    scale = side / 512
    image = Image.new('RGBA', (side, side))
    draw = ImageDraw.Draw(image)
    if bg is not None:
        draw.rounded_rectangle((0, 0, side - 1, side - 1), radius=RADIUS * scale, fill=bg)
    radius = STROKE * scale / 2
    for section in mark_points():
        for x, y in section:
            cx, cy = x * scale, y * scale
            draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), fill=color)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def svg(background=False):
    tile = f'<rect width="512" height="512" rx="{RADIUS}" fill="{IRIS}"/>' if background else ''
    color = '#FFFFFF' if background else IRIS
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">{tile}'
            f'<path d="{PATH}" fill="none" stroke="{color}" stroke-width="{STROKE}" '
            'stroke-linecap="round" stroke-linejoin="round"/></svg>\n')


def preview():
    image = Image.new('RGB', (1200, 720), '#FAFAFD')
    draw = ImageDraw.Draw(image)
    def text(xy, value, size=22, color='#77738E'):
        try:
            font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', size)
        except OSError:
            font = ImageFont.load_default(size=size)
        draw.text(xy, value, font=font, fill=color)
    draw.rectangle((0, 0, 1199, 489), fill='#EEECFA')
    text((48, 30), 'Notidea / An unfinished n', 25)
    app = render(336)
    image.paste(app, (72, 104), app)
    text((480, 145), 'notidea', 82, '#25233D')
    text((488, 260), 'Before it\u2019s an idea.', 28)
    text((488, 337), 'Iris #6255D9  /  stroke 64  /  open gap 44', 20)
    text((48, 516), 'Actual pixel sizes', 20)
    x = 48
    for size in (16, 20, 24, 32, 48, 64):
        icon = render(size)
        image.paste(icon, (x, 570), icon)
        text((x, 650), str(size), 16)
        x += size + 38
    for x, background, color in ((720, '#FAFAFD', IRIS), (930, '#25233D', '#FFFFFF')):
        draw.rounded_rectangle((x, 520, x+160, 680), radius=28, fill=background)
        mark = render(160, bg=None, color=color)
        image.paste(mark, (x, 520), mark)
    image.save(DESIGN / 'notidea-logo-preview.png')


def main():
    for directory in (OUT, PUB, DESIGN):
        directory.mkdir(parents=True, exist_ok=True)
    app = render()
    app.save(OUT / 'icon.png')
    app.save(DESIGN / 'notidea-app-icon.png')
    render(32).save(OUT / 'icon-32.png')
    frames = [render(size) for size in ICO_SIZES]
    frames[-1].save(OUT / 'notidea.ico', format='ICO',
                    sizes=[(size, size) for size in ICO_SIZES], append_images=frames[:-1])
    render(32).save(PUB / 'favicon.png')
    render(180).save(PUB / 'apple-touch-icon.png')
    (DESIGN / 'notidea-mark.svg').write_text(svg(), encoding='utf-8')
    (DESIGN / 'notidea-app-icon.svg').write_text(svg(background=True), encoding='utf-8')
    preview()
    print(f'Generated icons and design assets from {Path(__file__).resolve()}')
    print(f'Path: {PATH}; stroke={STROKE}; ICO sizes={ICO_SIZES}')


if __name__ == '__main__':
    main()
