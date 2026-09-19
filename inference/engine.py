"""Turns image bytes into a prediction, reusing predict.py unchanged.

The important property here is that the checkpoint is loaded exactly once, at
worker startup, and then reused for every job. Loading it per message would
rebuild a ResNet18 and read 44 MB from disk before each forward pass -- work
that dwarfs the inference itself and would make throughput a function of disk
speed rather than of compute.

Nothing in this file re-implements prediction. `load_model` and `classify` are
imported from predict.py exactly as the CLI uses them, so the web path and the
command line cannot disagree about what the model says: there is one
implementation and two callers.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass

# This import must come before `import torch`, and the order is load-bearing
# rather than stylistic. On Windows, predict.py puts the MSVC runtime DLLs that
# ship inside the virtualenv onto the loader path at import time; torch's own
# DLLs link against them and fail with WinError 126 if they are not there yet.
# Importing torch first therefore breaks the worker on a Windows host before a
# single line of this module runs. In the Linux container the shim is inert and
# the ordering costs nothing.
from predict import classify, load_model  # isort: skip

import torch
from PIL import UnidentifiedImageError


class InvalidImage(Exception):
    """The bytes are not a decodable image.

    Permanent by nature: the same bytes will not decode on a second attempt.
    The backend sniffs magic numbers before accepting an upload, so reaching
    this means a file whose header was right and whose body was not -- a
    truncated transfer, typically.
    """


@dataclass(frozen=True)
class Prediction:
    predicted_class: str
    confidence: float
    probabilities: dict[str, float]
    # Covers decode, preprocessing and the forward pass together -- the honest
    # cost of answering, not just the matrix multiplication.
    duration_ms: int


class InferenceEngine:
    def __init__(self, model_path: str, torch_threads: int = 0) -> None:
        if torch_threads > 0:
            # Each replica otherwise sizes its thread pool to every core on the
            # host, so running three workers on four cores has them fighting
            # each other for the same CPUs.
            torch.set_num_threads(torch_threads)

        model, class_names, preprocess, checkpoint = load_model(model_path)
        self._model = model
        self._class_names = class_names
        self._preprocess = preprocess

        # Provenance, recorded on every row this worker writes so a prediction
        # can always be traced back to the checkpoint that produced it.
        self.arch: str = str(checkpoint.get("arch", "unknown"))
        val_acc = checkpoint.get("val_acc")
        self.val_acc: float | None = float(val_acc) if val_acc is not None else None
        self.class_names: list[str] = list(class_names)

    def classify_bytes(self, data: bytes) -> Prediction:
        """Classify an in-memory image.

        `classify` names its last parameter `image_path`, but it only passes it
        to `Image.open`, which documents file objects as an accepted input
        alongside paths. Handing it a BytesIO therefore needs no change to
        predict.py and avoids writing a temporary file per job purely to read
        it back one line later.
        """
        started = time.perf_counter()

        try:
            label, confidence, probabilities = classify(
                self._model, self._preprocess, self._class_names, io.BytesIO(data)
            )
        except (UnidentifiedImageError, OSError, ValueError) as error:
            # OSError also covers PIL's "image file is truncated".
            raise InvalidImage(f"could not decode the uploaded image: {error}") from error

        duration_ms = int((time.perf_counter() - started) * 1000)

        return Prediction(
            predicted_class=label,
            confidence=float(confidence),
            probabilities={
                name: float(probability)
                for name, probability in zip(self._class_names, probabilities.tolist())
            },
            duration_ms=duration_ms,
        )
