"""Build the synthetic, text-layer PDF used by inventory-import tests."""

from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


target = Path(__file__).with_name("ask-import-stock.pdf")
page = canvas.Canvas(str(target), pagesize=letter)
page.setTitle("Synthetic inventory export for StockChief certification")
page.setFont("Helvetica-Bold", 16)
page.drawString(42, 748, "Lab inventory export")
page.setFont("Helvetica", 9)
page.drawString(42, 729, "Synthetic test data - exported 15 August 2026")

columns = [(42, "Stock code"), (145, "Item description"), (350, "Qty available"), (450, "Site")]
page.setFont("Helvetica-Bold", 10)
for x, label in columns:
    page.drawString(x, 695, label)
page.line(42, 689, 570, 689)

rows = [
    ("LAB-PT-012", "PTFE Tape 12 m", "24", "Lab Main Warehouse"),
    ("LAB-BN-015", "Brass Compression Nut", "36", "Lab Main Warehouse"),
    ("LAB-PC-022", "Pipe Cutter 22 mm", "7", "Lab Overflow Shelf"),
]
page.setFont("Helvetica", 10)
for index, row in enumerate(rows):
    y = 671 - index * 23
    for (x, _), value in zip(columns, row):
        page.drawString(x, y, value)
page.setFont("Helvetica-Oblique", 8)
page.drawString(42, 575, "Certification fixture only. No real customer or supplier data.")
page.showPage()
page.save()
print(target)
