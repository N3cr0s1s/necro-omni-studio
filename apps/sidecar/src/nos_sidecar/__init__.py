"""Necro Omni Studio media sidecar.

A local HTTP service owning everything that needs ffmpeg or the filesystem: media probing,
proxy/filmstrip/waveform derivation, project scanning and (later) SAM 2 segmentation.

It exists as a separate process rather than as Electron main-process code for two reasons. The
GPU-bound work — segmentation, and eventually anything that shares VRAM with a generator backend —
belongs in Python where those libraries live, and a crash in a decoder must not take the editor
down with it.
"""

__version__ = "0.1.0"
