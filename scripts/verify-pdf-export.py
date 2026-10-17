"""Pixel-level PDF export regression check; run after npm test (requires pypdfium2, pypdf, Pillow)."""
from pathlib import Path
import pypdfium2 as pdfium
from pypdf import PdfReader

root = Path('work/pdf-export-qa')
document = pdfium.PdfDocument(root / 'annotated.pdf')
for index, angle in enumerate((0, 90, 180, 270)):
    image = document[index].render(scale=1).to_pil().convert('RGB')
    red = [(x, y) for y in range(image.height) for x in range(image.width) if (lambda p: p[0] > 200 and p[1] < 60 and p[2] < 60)(image.getpixel((x, y)))]
    assert red, f'No visible red ink at page rotation {angle}'
    bounds = min(x for x, _ in red), min(y for _, y in red), max(x for x, _ in red), max(y for _, y in red)
    assert 38 <= bounds[0] <= 41 and 139 <= bounds[2] <= 141, (angle, bounds)
    assert 45 <= bounds[1] <= 47 and 53 <= bounds[3] <= 55, (angle, bounds)
    image.save(root / f'rotation-{angle}.png')
    print(f'PASS rotation {angle}, cropped page: red ink bounds {bounds}')
reader = PdfReader(root / 'annotated.pdf')
for page in reader.pages:
    assert 'Original content preserved' in page.extract_text()
print('PASS original PDF text remains extractable on all 4 pages')
