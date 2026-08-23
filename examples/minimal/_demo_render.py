#!/usr/bin/env python3
"""
demo_render.py — gera docs/assets/demo.gif (PIL, sem captura de ecra).

Cada frame e desenhado por nos: nenhum segredo possivel por construcao.
Roteiro de 07-COMUNIDADE §4.1 em versao OFFLINE e verificavel: portao real
(401 sem credencial -> 200 com credencial -> pgrep vazio ao fim).
"""
import os, glob
from PIL import Image, ImageDraw, ImageFont

OUT = os.environ.get('DEMO_FRAME_DIR', '/tmp/demo_frames')
os.makedirs(OUT, exist_ok=True)
for f in glob.glob(OUT + '/*.png'):
    os.remove(f)

W, H = 460, 340
BG   = (17, 20, 27)
FG   = (230, 237, 243)
DIM  = (150, 160, 170)
GREEN= (64, 214, 132)
RED  = (255, 94, 94)
YELLOW=(240, 191, 76)
ACC  = (90, 150, 255)
TIT  = (45, 51, 63)

def F(sz):
    try:
        return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', sz)
    except Exception:
        return ImageFont.load_default()

FS_MD = F(15)
FS_CAP = F(15)
FS_TITLE = F(15)

def window(d, title):
    d.rounded_rectangle([6,6,W-6,H-6], radius=10, fill=BG, outline=(60,70,90), width=2)
    d.rounded_rectangle([6,6,W-6,32], radius=10, fill=TIT, outline=(60,70,90), width=2)
    for i,(c,color) in enumerate([(20,RED),(34,YELLOW),(48,GREEN)]):
        d.ellipse([c-4,20-4,c+4,20+4], fill=color)
    d.text((74,16), title, font=FS_TITLE, fill=FG)

def lines(d, items, y=50, step=22):
    for text, color in items:
        d.text((20, y), text, font=FS_MD, fill=color)
        y += step
    return y

def cap(d, text, color=FG):
    d.text((10, H-24), text, font=FS_CAP, fill=color)

def base():
    im = Image.new('RGB', (W,H), (10,12,16))
    d = ImageDraw.Draw(im)
    return im, d

frame_index = [0]
def emit(im):
    im.save(os.path.join(OUT, 'f%04d.png' % frame_index[0]))
    frame_index[0] += 1

def hold(im, n=8):
    for _ in range(n):
        emit(im)

# ---------- Scene 1 (t 0-3s): bind 127.0.0.1, 401 ----------
cmd = "$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/api/commands/execute"
prompt_head = [
    ("$ dsh web", FG),
    (" [guarded-bot] bind 127.0.0.1:3080 - OK", DIM),
    (" [guarded-bot] senha gerada (aparece UMA vez)", GREEN),
]
for nch in range(1, len(cmd)+1):
    im, d = base()
    window(d, "guard-messenger  [dsh]")
    lines(d, prompt_head)
    d.text((20, 116), cmd[:nch], font=FS_MD, fill=FG)
    cap(d, "0-3s  bind travado em 127.0.0.1 • prova: /api sem credencial", ACC)
    emit(im)

im, d = base()
window(d, "guard-messenger  [dsh]")
lines(d, prompt_head)
d.text((20, 116), cmd, font=FS_MD, fill=FG)
d.text((20, 140), "401", font=F(22), fill=RED)
cap(d, "401  sem credencial nao se passa", RED)
hold(im, 12)

# ---------- Scene 2 (t 3-7s): senha pela maquina, nunca via Telegram ----------
im, d = base()
window(d, "terminal local")
items = [
    (" [guarded-bot] senha gerada (CSPRNG, 256 bits):", GREEN),
    (" K7QF-2M9X-****-****-****-*MPV", FG),
    (" [guarded-bot] a senha NAO vai pelo Telegram (SEC-14)", YELLOW),
    (" [guarded-bot] chat de bot e cloud chat, nao e E2E", DIM),
]
lines(d, items, y=90)
cap(d, "3-7s  senha gerada pela maquina, entregue 1x no terminal", ACC)
hold(im, 16)

# ---------- Scene 3 (t 7-11s): com a credencial -> 200 ----------
cmd2 = "$ curl -s -o /dev/null -w '%{http_code}' -u dsh:******** http://127.0.0.1:3080/api"
for nch in range(1, len(cmd2)+1):
    im, d = base()
    window(d, "guard-messenger  [dsh]")
    lines(d, prompt_head[:2])
    d.text((20, 116), cmd2[:nch], font=FS_MD, fill=FG)
    cap(d, "7-11s  com a credencial do dono passa-se", ACC)
    emit(im)
im, d = base()
window(d, "guard-messenger  [dsh]")
lines(d, prompt_head[:2])
d.text((20, 116), cmd2, font=FS_MD, fill=FG)
d.text((20, 140), "200", font=F(22), fill=GREEN)
cap(d, "200  a Web UI inteira fica acessivel (autenticado)", GREEN)
hold(im, 16)

# ---------- Scene 4 (t 11-16s): clean shutdown, pgrep empty ----------
cmd3 = "$ pgrep -f examples/minimal/server.mjs"
for nch in range(1, len(cmd3)+1):
    im, d = base()
    window(d, "kill switch")
    lines(d, [(" (Ctrl-C  /  dsh plugin remove)", DIM)])
    d.text((20, 116), cmd3[:nch], font=FS_MD, fill=FG)
    cap(d, "11-16s  kill switch: nada sobra", ACC)
    emit(im)
im, d = base()
window(d, "kill switch")
lines(d, [(" (Ctrl-C  /  dsh plugin remove)", DIM)])
d.text((20, 116), cmd3, font=FS_MD, fill=FG)
d.text((20, 140), "pgrep: vazio (nenhum processo sobrante)", font=FS_MD, fill=GREEN)
cap(d, "nenhum cloudflared, nenhum worker: zerado ao fim", GREEN)
hold(im, 16)

print("frames:", frame_index[0])
