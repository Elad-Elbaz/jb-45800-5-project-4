"""Tests for the inference engine, against the committed checkpoint.

    cd inference && pip install -r requirements-dev.txt && pytest

These exercise the real rps_model.pt rather than a stub. The point is not to
assert what the model predicts -- the inputs here are synthetic and the answer
is meaningless -- but to prove the seam between the worker and predict.py
holds: that a checkpoint loads, that in-memory bytes work where the CLI passes
a path, and that undecodable input raises the one exception the worker is
written to catch.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from engine import InferenceEngine, InvalidImage

MODEL_PATH = Path(__file__).with_name("rps_model.pt")


@pytest.fixture(scope="module")
def engine() -> InferenceEngine:
    """Loaded once for the module, exactly as the worker loads it once."""
    if not MODEL_PATH.is_file():
        pytest.skip(f"{MODEL_PATH.name} is not present")
    return InferenceEngine(str(MODEL_PATH))


def png_bytes(mode: str = "RGB", size: tuple[int, int] = (300, 200)) -> bytes:
    image = Image.new(mode, size, (40, 160, 90) if mode == "RGB" else (40, 160, 90, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_the_checkpoint_carries_its_own_provenance(engine: InferenceEngine) -> None:
    """train.py writes these into the .pt, and nothing here hardcodes them."""
    assert engine.arch == "resnet18"
    assert sorted(engine.class_names) == ["paper", "rock", "scissors"]
    assert engine.val_acc is not None and 0.0 <= engine.val_acc <= 1.0


def test_classifies_bytes_rather_than_a_path(engine: InferenceEngine) -> None:
    """The seam that matters.

    predict.classify names its parameter `image_path` and the CLI passes a
    Path; the worker hands it a BytesIO so that no temporary file has to be
    written per job. PIL documents file objects as acceptable, and this is
    what proves it for the version actually installed.
    """
    prediction = engine.classify_bytes(png_bytes())

    assert prediction.predicted_class in engine.class_names
    assert 0.0 <= prediction.confidence <= 1.0
    assert prediction.duration_ms >= 0


def test_returns_the_whole_distribution(engine: InferenceEngine) -> None:
    prediction = engine.classify_bytes(png_bytes())

    assert set(prediction.probabilities) == set(engine.class_names)
    assert prediction.probabilities[prediction.predicted_class] == pytest.approx(
        prediction.confidence
    )
    # A softmax row, so it sums to one; the UI draws it as a distribution.
    assert sum(prediction.probabilities.values()) == pytest.approx(1.0, abs=1e-4)


def test_accepts_an_image_with_an_alpha_channel(engine: InferenceEngine) -> None:
    """The dataset is PNG, and PNGs routinely carry alpha.

    predict.py converts to RGB before preprocessing; without that the tensor
    would have four channels and the first convolution would reject it.
    """
    prediction = engine.classify_bytes(png_bytes(mode="RGBA"))
    assert prediction.predicted_class in engine.class_names


@pytest.mark.parametrize(
    ("label", "data"),
    [
        ("plain garbage", b"this is definitely not an image"),
        ("empty input", b""),
        # Passes the backend's magic-number check and still cannot be decoded,
        # which is the exact case that reaches the worker in practice.
        ("a truncated png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64),
    ],
)
def test_undecodable_input_raises_invalid_image(
    engine: InferenceEngine, label: str, data: bytes
) -> None:
    """InvalidImage is the only exception the worker treats as permanent here.

    Anything else would be caught by the catch-all and reported as an
    unexpected error, which is both wrong and unhelpful.
    """
    with pytest.raises(InvalidImage):
        engine.classify_bytes(data)
