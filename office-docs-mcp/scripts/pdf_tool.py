import sys
import json
import os
import io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas


def read_pdf(path, **_):
    reader = PdfReader(path)
    pages = [page.extract_text() or "" for page in reader.pages]
    return {"numPages": len(pages), "pages": pages}


def merge(paths, output_path, **_):
    if not paths or len(paths) < 2:
        raise RuntimeError("paths 至少需要兩個檔案才需要合併")
    writer = PdfWriter()
    for p in paths:
        writer.append(p)
    with open(output_path, "wb") as f:
        writer.write(f)
    return {"path": output_path, "sourceCount": len(paths)}


def extract_pages(path, pages, output_path, **_):
    """pages 是 1-based 頁碼陣列（可跳頁、可任意順序），不是連續 range 才需要特別指定。"""
    reader = PdfReader(path)
    writer = PdfWriter()
    for p in pages:
        idx = p - 1
        if idx < 0 or idx >= len(reader.pages):
            raise RuntimeError(f"頁碼超出範圍: {p}（總頁數 {len(reader.pages)}）")
        writer.add_page(reader.pages[idx])
    with open(output_path, "wb") as f:
        writer.write(f)
    return {"path": output_path, "extractedPages": pages}


def watermark(path, text, output_path, **_):
    reader = PdfReader(path)
    writer = PdfWriter()

    first_box = reader.pages[0].mediabox
    width, height = float(first_box.width), float(first_box.height)

    overlay_buffer = io.BytesIO()
    c = canvas.Canvas(overlay_buffer, pagesize=(width, height))
    c.saveState()
    c.setFont("Helvetica", 40)
    c.setFillGray(0.5, 0.3)
    c.translate(width / 2, height / 2)
    c.rotate(45)
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()
    overlay_buffer.seek(0)
    overlay_page = PdfReader(overlay_buffer).pages[0]

    for page in reader.pages:
        page.merge_page(overlay_page)
        writer.add_page(page)

    with open(output_path, "wb") as f:
        writer.write(f)
    return {"path": output_path, "watermarkedPages": len(reader.pages)}


def fill_form(path, fields, output_path, **_):
    reader = PdfReader(path)
    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, fields)
    with open(output_path, "wb") as f:
        writer.write(f)
    return {"path": output_path, "fieldsFilled": list(fields.keys())}


ACTIONS = {
    "read": read_pdf,
    "merge": merge,
    "extract_pages": extract_pages,
    "watermark": watermark,
    "fill_form": fill_form,
}


def main():
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    action = payload.get("action")
    if action not in ACTIONS:
        raise RuntimeError(f"未知的 action: {action}（可用: {', '.join(ACTIONS)}）")
    result = ACTIONS[action](**{k: v for k, v in payload.items() if k != "action"})
    print(json.dumps({"success": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "message": str(e)}, ensure_ascii=False))
        sys.exit(1)
