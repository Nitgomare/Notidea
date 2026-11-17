"""生成 拾念 / Notidea 图标：设计稿的紫色圆角方块 + 白色「开口 n」标记

几何来自 design/notidea/notidea-app-icon.svg：
  <rect width="512" height="512" rx="116" fill="#6255D9"/>
  <path d="M160 354V226C160 120 336 120 336 226M336 288V354"
        stroke="#FFFFFF" stroke-width="48" stroke-linecap="round"/>
"""
import os
import math
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
PUB = os.path.join(os.path.dirname(__file__), '..', 'public')
os.makedirs(OUT, exist_ok=True)
os.makedirs(PUB, exist_ok=True)

IRIS = (98, 85, 217, 255)      # #6255D9
SIZE = 1024
SS = 4                          # 超采样倍数
W = 48.0 / 512 * SIZE           # 笔画宽度（按设计稿等比）
RADIUS = 116.0 / 512 * SIZE


def mark_points(step=120):
    """按 SVG 路径采样中心线：竖线 -> 三次贝塞尔 -> 短竖线"""
    def sc(x, y):
        return (x / 512.0 * SIZE, y / 512.0 * SIZE)

    def lerp(a, b, n):
        return [sc(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]

    pts = lerp((160, 354), (160, 226), step // 4)      # 竖线也要细分，否则盖章只有两端
    for i in range(1, step + 1):
        t = i / step
        u = 1 - t
        x = u**3 * 160 + 3 * u * u * t * 160 + 3 * u * t * t * 336 + t**3 * 336
        y = u**3 * 226 + 3 * u * u * t * 120 + 3 * u * t * t * 120 + t**3 * 226
        pts.append(sc(x, y))
    return pts, lerp((336, 288), (336, 354), step // 8)


def draw_mark(d, color, scale=1.0):
    pts, tail = mark_points()
    w = max(1, round(W * scale))
    d.line(pts, fill=color, width=w, joint='curve')
    # 每段两端的圆头
    for cx, cy in (pts[0], pts[-1], tail[0], tail[1]):
        r = w / 2.0
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    d.line(tail, fill=color, width=w)


def render(bg=None, mark_color=(255, 255, 255, 255), radius=RADIUS):
    """bg 为 None 时输出透明底（用于纯标记）"""
    s = SIZE * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg is not None:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(radius * SS), fill=bg)
    # 标记按 512 坐标系等比放大
    pts, tail = mark_points(400)
    k = SS
    w = max(1, round(W * k))
    r = w / 2.0
    # 沿中心线密集盖章（Pillow 的多段线在急转弯处会有尖刺）
    for seg in (pts, tail):
        for (x, y) in seg:
            cx, cy = x * k, y * k
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=mark_color)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    app = render(bg=IRIS)
    app.save(os.path.join(OUT, 'icon.png'))
    app.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, 'icon-180.png'))
    app.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, 'icon-64.png'))
    app.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'icon-32.png'))

    sizes = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]
    app.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'notidea.ico'), sizes=sizes)

    app.resize((32, 32), Image.LANCZOS).save(os.path.join(PUB, 'favicon.png'))
    app.resize((180, 180), Image.LANCZOS).save(os.path.join(PUB, 'apple-touch-icon.png'))

    # 纯标记（给界面内联用，透明底）
    render(bg=None, mark_color=IRIS).save(os.path.join(OUT, 'mark.png'))
    print('icons ->', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
