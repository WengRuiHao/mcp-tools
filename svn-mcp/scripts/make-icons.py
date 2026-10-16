"""
產生 svn-edit 的圖標：
  - assets/totoro.ico          多尺寸圖標（exe 圖標、網頁 favicon、桌面視窗圖標共用）
  - src/edit-icon-data.ts      把 ico 與頁首 logo 內嵌成 base64，讓單一 exe 不需要額外檔案

所有尺寸統一用幾何圖形畫的「簡化版龍貓」——粗色塊、大眼睛、高對比，跟 Word、VS Code 的圖標一樣在小尺寸也看得清楚
（30、36、42 是 125%、150%、175% 縮放下工作列的實際尺寸）。
以前 96 像素以上改用 assets/totoro-src.jpg 照片裁切，結果 Windows 在高 DPI 工作列、Alt+Tab、放大圖示時挑到大尺寸，
看到的就是另一種畫風，跟檔案總管的 exe 圖標對不起來；現在每個尺寸都是同一張設計，到處看起來一致。

需要 Pillow（只有重新產生圖標時才需要，不是專案相依）：python scripts/make-icons.py
"""
import base64
import io
import math
import struct

from PIL import Image, ImageDraw, ImageFilter

SIZES = [16, 20, 24, 30, 32, 36, 40, 42, 48, 60, 64, 72, 96, 128, 256]
CORNER_RATIO = 0.22
SUPERSAMPLE = 4
CANVAS = 1024  # 簡化版先畫在 1024 的畫布，再縮到各尺寸

GREEN = (143, 203, 92, 255)
BODY = (122, 104, 94, 255)
BELLY = (246, 242, 212, 255)
WHITE = (255, 255, 255, 255)
DARK = (44, 36, 34, 255)


def ellipse_points(cx, cy, rx, ry, deg=0.0, steps=96):
    """旋轉過的橢圓多邊形（用來畫耳朵）。"""
    t = math.radians(deg)
    pts = []
    for i in range(steps):
        a = 2 * math.pi * i / steps
        x, y = rx * math.cos(a), ry * math.sin(a)
        pts.append((cx + x * math.cos(t) - y * math.sin(t), cy + x * math.sin(t) + y * math.cos(t)))
    return pts


def rounded_mask(size):
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * CORNER_RATIO), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def draw_simple_totoro():
    """簡化版龍貓（1024x1024，含綠色圓角底）。小尺寸的辨識度全靠這幾個大色塊。"""
    img = Image.new("RGBA", (CANVAS, CANVAS), GREEN)
    d = ImageDraw.Draw(img)
    # 耳朵（先畫，身體蓋在上面）
    d.polygon(ellipse_points(318, 255, 92, 190, -16), fill=BODY)
    d.polygon(ellipse_points(706, 255, 92, 190, 16), fill=BODY)
    # 身體與肚子
    d.ellipse((140, 230, 884, 1000), fill=BODY)
    d.ellipse((262, 560, 762, 1010), fill=BELLY)
    # 肚子上的三道紋
    for cx, cy, w in ((512, 650, 90), (385, 705, 66), (639, 705, 66)):
        d.arc((cx - w, cy - w * 0.55, cx + w, cy + w * 0.55), 200, 340, fill=BODY, width=26)
    # 眼睛：大而白，瞳孔偏下，辨識度最高
    for ex in (372, 652):
        d.ellipse((ex - 92, 415 - 92, ex + 92, 415 + 92), fill=WHITE)
        d.ellipse((ex - 38 + (10 if ex < 512 else -10), 430 - 38, ex + 38 + (10 if ex < 512 else -10), 430 + 38 + 8), fill=DARK)
    # 鼻子
    d.ellipse((512 - 52, 520 - 30, 512 + 52, 520 + 30), fill=DARK)
    return img


def render_simple(size):
    img = draw_simple_totoro().resize((size, size), Image.LANCZOS)
    img = img.filter(ImageFilter.UnsharpMask(radius=0.6, percent=70, threshold=1))
    img.putalpha(rounded_mask(size))
    return img


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def build_ico(images):
    """手動組 ICO 容器（每個尺寸一筆 PNG 內容），PIL 內建的 ICO 輸出只會從同一張圖縮放。"""
    entries = [(img.width, png_bytes(img)) for img in images]
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory, blobs = b"", b""
    for size, data in entries:
        directory += struct.pack("<BBBBHHII", 0 if size >= 256 else size, 0 if size >= 256 else size, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + directory + blobs


def main():
    images = [render_simple(s) for s in SIZES]
    ico = build_ico(images)
    open("assets/totoro.ico", "wb").write(ico)
    logo = png_bytes(render_simple(96))
    ts = (
        "// 由 scripts/make-icons.py 產生，請勿手動修改。\n"
        f'export const FAVICON_ICO_BASE64 = "{base64.b64encode(ico).decode()}";\n'
        f'export const LOGO_PNG_BASE64 = "{base64.b64encode(logo).decode()}";\n'
    )
    open("src/edit-icon-data.ts", "w", encoding="utf-8", newline="\n").write(ts)
    print(f"totoro.ico {len(ico)} bytes, sizes={SIZES}; logo {len(logo)} bytes")


if __name__ == "__main__":
    main()
