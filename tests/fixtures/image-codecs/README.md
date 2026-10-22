These images are synthetic inventory tables authored for codec and OCR regression tests. They contain no customer data.

`stock-count.heic` is HEIC; `stock-count.tiff` is LZW-compressed TIFF. `two-count-pages.tiff` contains two independently numbered product tables. `oriented-count.tiff` uses TIFF orientation 6 and must produce the same upright table. `stock-count-reference.png` is the original rendered table for visual comparison.

All images exercise quantities and costs of zero, reorder points and supplier lead times. Tests compare the actual pixels read through StockChief's shared OCR and review path, rather than supplying a pre-extracted table.
