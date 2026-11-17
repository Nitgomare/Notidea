"""Compatibility entry point; geometry and all output live in tools/make-icon.py."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).resolve().parents[2] / 'tools' / 'make-icon.py'),
                   run_name='__main__')
