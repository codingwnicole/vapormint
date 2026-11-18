#!/usr/bin/env python3
"""Run the shipped pixel-analysis script on deterministic, uncompressed fixtures."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT, FRAMES, FPS = 160, 96, 48, 24

def fixture(path: Path, kind: str) -> None:
    header = f'YUV4MPEG2 W{WIDTH} H{HEIGHT} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode()
    chroma = bytes([128]) * (WIDTH * HEIGHT // 2)
    with path.open('wb') as out:
        out.write(header)
        for frame in range(FRAMES):
            if kind == 'flat':
                y = bytes([96]) * (WIDTH * HEIGHT)
            elif kind == 'moving':
                y = bytes((x * 3 + row * 5 + frame * 7) % 220 + 16 for row in range(HEIGHT) for x in range(WIDTH))
            else:
                y = bytes(((x * 2 + (frame + (row % 2) * 3) * 11) % 220) + 16 for row in range(HEIGHT) for x in range(WIDTH))
            out.write(b'FRAME\n' + y + chroma)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--expected')
    parser.add_argument('--output')
    parser.add_argument('--scalar', action='store_true', help='Diagnostic: disable FFmpeg CPU optimizations for pixel conversion')
    args = parser.parse_args()
    results = {}
    with tempfile.TemporaryDirectory(prefix='vapormint-brain-parity-') as temp:
        brain = ROOT / 'scripts/cf_analysis.py'
        if args.scalar:
            original = brain.read_text(encoding='utf8')
            needle = 'cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-an"]'
            if needle not in original: raise RuntimeError('Cannot instrument brain decoder')
            brain = Path(temp) / 'scalar_brain.py'
            brain.write_text(original.replace(needle, 'cmd = [ffmpeg, "-cpuflags", "0", "-hide_banner", "-loglevel", "error", "-an"]'), encoding='utf8')
        for kind in ('flat', 'moving', 'interlaced-pattern'):
            video = Path(temp) / f'{kind}.y4m'
            fixture(video, kind)
            run = subprocess.run([sys.executable, str(brain), '--input', str(video), '--probe', json.dumps({'duration':FRAMES/FPS, 'fps':FPS}), '--ffmpeg', str(Path(args.ffmpeg).resolve())], capture_output=True, text=True, check=True)
            result = json.loads(run.stdout)
            if not result.get('ok'): raise RuntimeError(f'{kind}: {result}')
            results[kind] = result['analysis']
    text = json.dumps(results, indent=2, sort_keys=True) + '\n'
    if args.output: Path(args.output).write_text(text, encoding='utf8')
    if args.expected:
        expected = json.loads(Path(args.expected).read_text(encoding='utf8'))
        if results != expected:
            print('Brain results differ from the reference:')
            for kind in results:
                if results[kind] != expected.get(kind):
                    print(f'{kind}: expected {json.dumps(expected.get(kind), sort_keys=True)}')
                    print(f'{kind}: actual   {json.dumps(results[kind], sort_keys=True)}')
            raise SystemExit(1)
        print('All brain measurements match the reference exactly.')
    else: print(text, end='')

if __name__ == '__main__': main()
