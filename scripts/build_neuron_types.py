"""Build data/neuron_types.json: indices of real, literature-identified
FlyWire cell types in the worker's group-sorted neuron order.

The game reads decisions (take off, land) from these cells instead
of hand-written thresholds, and delivers stimuli (looming shadow, body jolt)
into them.

Inputs (download once, not committed):
  neurons.csv.gz        https://raw.githubusercontent.com/snedea/flybrain/main/data/neurons.csv.gz
                        row order == original neuron index in data/connectome.bin.gz
  annotations.tsv       https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv
                        FlyWire v783 cell types (Schlegel et al. 2024)

Usage: python3 scripts/build_neuron_types.py <dir with the two inputs>
"""
import csv
import gzip
import json
import sys

import numpy as np

REPO = __file__.rsplit('/scripts/', 1)[0]
src = sys.argv[1] if len(sys.argv) > 1 else '.'

raw = gzip.open(f'{REPO}/data/connectome.bin.gz').read()
N, E = (int(x) for x in np.frombuffer(raw[:8], dtype='<u4'))
meta = np.frombuffer(raw[8 + E * 12:8 + E * 12 + N * 3], dtype=np.dtype([('rt', 'u1'), ('g', '<u2')]))
# sim-worker.js buildGroupStructures(): stable counting sort by group id.
order = np.argsort(meta['g'].astype(int), kind='stable')
sorted_pos = np.empty(N, dtype=np.int64)
sorted_pos[order] = np.arange(N)

root_ids = [r['root_id'] for r in csv.DictReader(gzip.open(f'{src}/neurons.csv.gz', 'rt'))]
assert len(root_ids) == N
ann = {r['root_id']: r for r in csv.DictReader(open(f'{src}/annotations.tsv'), delimiter='\t')}


def pick(pred):
    orig = [i for i, rid in enumerate(root_ids) if rid in ann and pred(ann[rid])]
    return sorted(int(sorted_pos[i]) for i in orig)


def cell_types(*names):
    return pick(lambda a: a['cell_type'] in names)


out = {
    '_source': 'FlyWire v783 annotations (flyconnectome/flywire_annotations) joined by root_id; '
               'indices are sim-worker group-sorted positions. Built by scripts/build_neuron_types.py.',
    # Looming detectors: visual projection neurons that drive the escape
    # pathway (von Reyn et al. 2014, Ache et al. 2019).
    'loom': cell_types('LC4', 'LPLC2'),
    # Loom-specific escape command neurons: giant fiber DNp01 plus DNp04,
    # DNp11. Silent at rest in the simulation, fire on a looming shadow.
    'escapeDN': cell_types('DNp01', 'DNp04', 'DNp11'),
    # Takeoff DNs that respond to general strong input (odour, heat, optic
    # flow, body jolt) rather than looming alone.
    'arousalDN': cell_types('DNp02', 'DNp06'),
    # Landing DNs (Ache et al. 2019); silenced by looming.
    'landingDN': cell_types('DNp07', 'DNp10'),
    # Ascending neurons carry body/leg sensation (substrate vibration,
    # leg nociception) from the ventral nerve cord up to the brain.
    'ascending': pick(lambda a: a['super_class'] == 'ascending'),
}
for k, v in out.items():
    if not k.startswith('_'):
        print(f'{k:10s} {len(v)}')
json.dump(out, open(f'{REPO}/data/neuron_types.json', 'w'), separators=(',', ':'))
