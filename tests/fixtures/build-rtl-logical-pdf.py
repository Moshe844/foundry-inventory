"""Independent PDF producer regression: logical ToUnicode glyph order.

The PDF is a generated test document with no customer records. ReportLab is
only used to regenerate the frozen fixture; application/tests need no Python.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
root=Path(__file__).resolve().parent
pdfmetrics.registerFont(TTFont('HebrewFixture',str(root/'fonts'/'NotoSansHebrew.ttf')))
c=canvas.Canvas(str(root/'rtl-logical-table.pdf'),pagesize=(600,800))
c.setTitle('Generated inventory parser regression fixture')
def row(y,cells):
    for x,text in zip([40,180,350,460],cells):
        c.setFont('HebrewFixture' if any('\u0590' <= ch <= '\u05ff' for ch in text) else 'Helvetica',12)
        c.drawString(x,y,text)
row(740,['SKU','שם מוצר','כמות','מחיר'])
row(710,['GEN-A7','מחברת ירוקה','3','11.25'])
row(680,['GEN-B9','מחברת כחולה','4','9.50'])
row(650,['','סה״כ יחידות','7',''])
row(620,['','מע״מ 17%','','12.20'])
row(590,['','סה״כ לתשלום','','83.95'])
c.showPage();c.save()
