# -*- coding: utf-8 -*-
"""重绘 Mine 应用图标：白色圆角底 + 黑色 "To Regalo"（Georgia 意大利斜体）。
用法：python draw_icons.py
生成 D:\\To-Regalo\\icons\\ 下 4 个 PNG（icon-192/512 + icon-maskable-192/512）。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
FONT = r"C:\Windows\Fonts\georgiai.ttf"  # Georgia Italic
TEXT = "To Regalo"
INK = (20, 20, 20, 255)                  # 近黑


def fit_font(draw, text, max_w, max_h, start_size):
    size = start_size
    while size > 6:
        font = ImageFont.truetype(FONT, size)
        bbox = font.getbbox(text)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w <= max_w and h <= max_h:
            return font, bbox
        size -= 2
    font = ImageFont.truetype(FONT, max(6, size))
    return font, font.getbbox(text)


def draw_icon(size, radius_pct, border_px, maskable=False):
    img = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    if not maskable:
        radius = int(size * radius_pct)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius,
                            fill=(255, 255, 255, 255),
                            outline=(224, 224, 224, 255), width=border_px)
    # 文字占宽：普通图标 ≤72%（留出圆角视觉边距），maskable ≤78%（安全区）
    max_w = size * (0.72 if not maskable else 0.78)
    max_h = size * 0.42
    font, bbox = fit_font(d, TEXT, max_w, max_h, int(size * 0.17))
    bbox = font.getbbox(TEXT)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    d.text((x, y), TEXT, font=font, fill=INK)
    return img


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    specs = [
        ("icon-192.png",          192, 0.21, 2, False),
        ("icon-512.png",          512, 0.21, 5, False),
        ("icon-maskable-192.png", 192, 0.0,  0, True),
        ("icon-maskable-512.png", 512, 0.0,  0, True),
    ]
    for name, size, rp, bp, mk in specs:
        draw_icon(size, rp, bp, mk).save(os.path.join(OUT, name), "PNG")
        print("saved", name)


if __name__ == "__main__":
    main()
