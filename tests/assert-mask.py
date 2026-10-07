import sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    pixel = image.convert('RGB').getpixel((int(sys.argv[2]), int(sys.argv[3])))
    expected = tuple(map(int, sys.argv[4].split(','))) if len(sys.argv) > 4 else (32, 37, 46)
    assert pixel == expected, f'Unexpected screenshot pixel: {pixel}, expected {expected}'
