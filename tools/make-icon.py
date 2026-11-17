"""生成 拾念 图标（占位版）"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
os.makedirs(OUT, exist_ok=True)

S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角纸片
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=(247, 244, 238, 255),
                    outline=(230, 224, 214, 255), width=6)

# 绿色圆
r = 152
cx, cy = S // 2, S // 2
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(31, 111, 74, 255))

# 白色衬线 f
font = ImageFont.truetype(r'C:\Windows\Fonts\georgiab.ttf', 268)
text = 'f'
box = d.textbbox((0, 0), text, font=font)
tw, th = box[2] - box[0], box[3] - box[1]
d.text((cx - tw / 2 - box[0], cy - th / 2 - box[1] - 8), text, font=font, fill=(247, 244, 238, 255))

img.save(os.path.join(OUT, 'icon.png'))
img.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, 'icon-180.png'))
img.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, 'icon-64.png'))
img.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'icon-32.png'))

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'notidea.ico'), sizes=sizes)
print('icons ->', os.path.abspath(OUT))
