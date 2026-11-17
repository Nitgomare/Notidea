from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

OUT = Path(__file__).resolve().parent
BLUE = '#6255D9'
INK = '#25233D'
WHITE = '#FFFFFF'
PALE = '#EEECFA'
MUTED = '#77738E'
S = 3

def mark(draw, box, color):
    x,y,size = box
    def p(a,b): return ((x+a*size/512)*S,(y+b*size/512)*S)
    pts=[p(160,354),p(160,226)]
    for i in range(1,101):
        t=i/100; u=1-t
        a=u**3*160+3*u*u*t*160+3*u*t*t*336+t**3*336
        b=u**3*226+3*u*u*t*120+3*u*t*t*120+t**3*226
        pts.append(p(a,b))
    width=48*size/512*S
    draw.line(pts,fill=color,width=round(width),joint='curve')
    for center in (pts[0],pts[-1]):
        cx,cy=center; r=width/2
        draw.ellipse((cx-r,cy-r,cx+r,cy+r),fill=color)
    a,b=p(336,288),p(336,354)
    draw.line([a,b],fill=color,width=round(width))
    for cx,cy in (a,b):
        r=width/2; draw.ellipse((cx-r,cy-r,cx+r,cy+r),fill=color)

def canvas(w,h,bg): return Image.new('RGB',(w*S,h*S),bg)
def rect(d,b,fill,r=0):
    b=tuple(round(v*S) for v in b)
    if r: d.rounded_rectangle(b,radius=round(r*S),fill=fill)
    else: d.rectangle(b,fill=fill)
def text(d,xy,s,size,color,font='C:/Windows/Fonts/segoeui.ttf'):
    d.text(tuple(round(v*S) for v in xy),s,font=ImageFont.truetype(font,round(size*S)),fill=color,stroke_width=0)
def save(im,name):
    im.resize((im.width//S,im.height//S),Image.Resampling.LANCZOS).save(OUT/name)

paths='<path d="M160 354V226C160 120 336 120 336 226M336 288V354" fill="none" stroke="{color}" stroke-width="48" stroke-linecap="round"/>'
for name,bg,col in [('notidea-mark.svg','',BLUE),('notidea-app-icon.svg','<rect width="512" height="512" rx="116" fill="'+BLUE+'"/>',WHITE)]:
    (OUT/name).write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'+bg+paths.format(color=col)+'</svg>',encoding='utf-8')
icon=Image.new('RGBA',(1024*S,1024*S),(0,0,0,0)); d=ImageDraw.Draw(icon)
rect(d,(0,0,1024,1024),BLUE,232); mark(d,(0,0,1024),WHITE)
save(icon,'notidea-app-icon.png')

im=canvas(1600,1080,'#FAFAFD'); d=ImageDraw.Draw(im)
rect(d,(0,0,1600,722),PALE)
text(d,(88,56),'Notidea / Visual identity',23,MUTED)
# One expressive shape, surrounded by quiet typography.
rect(d,(128,180,560,612),BLUE,100)
mark(d,(128,180,432),WHITE)
text(d,(690,265),'notidea',114,INK,'C:/Windows/Fonts/seguisb.ttf')
text(d,(698,429),"Before it’s an idea.",31,MUTED)
# The interruption is a literal pause in a lowercase n.
text(d,(90,770),'A thought, still taking shape.',29,INK)
text(d,(90,826),'An open n. A pause before the next line.',21,MUTED)
text(d,(90,947),'Iris  #6255D9',19,MUTED)
rect(d,(90,994,342,1002),BLUE,4)
# light and dark marks
mark(d,(670,785,230),BLUE)
rect(d,(988,778,1218,1008),INK,40); mark(d,(988,778,230),WHITE)
# actual small-size applications
text(d,(1325,788),'Small sizes',18,MUTED)
for xx,sz in [(1330,32),(1394,48),(1470,64)]:
    rect(d,(xx,864,xx+sz,864+sz),BLUE,sz*.225)
    mark(d,(xx,864,sz),WHITE)
save(im,'notidea-logo-preview.png')
print('Generated 2 SVG files, 1024px PNG icon, and 1600px preview.')
