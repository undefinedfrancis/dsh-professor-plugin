"""Original, synthetic PDF fixtures for packaged enhancement verification."""
import argparse
from pathlib import Path
import pymupdf

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
root = Path(parser.parse_args().out)
root.mkdir(parents=True, exist_ok=True)

source = pymupdf.open()
page = source.new_page()
page.insert_text((50, 70), "Scanned OCR source text", fontsize=20)
page.insert_text((50, 110), "扫描件读取测试", fontname="china-s", fontsize=20)
page.insert_text((50, 150), "E = mc^2, sqrt(2) approx 1.414", fontsize=16)
pixmap = page.get_pixmap(dpi=150)
scan = pymupdf.open()
scan.new_page().insert_image(page.rect, stream=pixmap.tobytes("png"))
scan.save(root / "scanned.pdf")
scan.close()
source.close()

table = pymupdf.open()
page = table.new_page()
rows = [["Name", "Value", "Unit"], ["mass", "3", "kg"],
        ["speed", "9.8", "m/s"], ["energy", "12.5", "J"]]
for number, row in enumerate(rows):
    for column, text in enumerate(row):
        page.insert_text((50 + column * 140, 70 + number * 24), text, fontsize=12)
table.save(root / "table_html.pdf")
table.close()
