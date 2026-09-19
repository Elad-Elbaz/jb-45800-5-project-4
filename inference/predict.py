"""Classify one or more images with a checkpoint produced by train.py.

Example:
    python predict.py --model ./rps_model.pt --image ./test_images/rock_1.png

This file is standalone -- it imports nothing from train.py. The architecture,
class names and preprocessing constants are read back out of the checkpoint,
so it still cannot drift out of sync with training: change the backbone or the
normalization there and predictions here follow along automatically.
"""

import argparse
import os
import sys
from pathlib import Path

if sys.platform == "win32":
    # See the matching note in train.py: make the venv's MSVC runtime DLLs
    # visible before torch is imported. No-op on macOS and Linux.
    for _dll_dir in (Path(sys.prefix) / "Scripts", Path(sys.prefix)):
        if (_dll_dir / "msvcp140.dll").is_file():
            os.add_dll_directory(str(_dll_dir))

import torch
import torch.nn as nn
from PIL import Image
from torchvision import models, transforms

# Deliberately duplicated from train.py rather than imported: this file has to
# stand on its own. Only the constructor is needed here, never the pretrained
# weights -- the checkpoint supplies every weight this script uses.
ARCHITECTURES = {
    "resnet18": models.resnet18,
    "resnet34": models.resnet34,
    "resnet50": models.resnet50,
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Predict the class of an image using a trained checkpoint."
    )
    parser.add_argument(
        "--model", default="rps_model.pt", help="Path to the .pt checkpoint."
    )
    parser.add_argument(
        "--image",
        required=True,
        nargs="+",
        help="One or more image files (or folders of images) to classify.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.0,
        help="Confidence below this fraction (0-1) reports 'no confident match'.",
    )
    return parser.parse_args()


def collect_images(paths):
    """Accept files, folders, or a mix of both; return a flat list of images."""
    suffixes = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
    images = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            images.extend(
                sorted(p for p in path.iterdir() if p.suffix.lower() in suffixes)
            )
        elif path.is_file():
            images.append(path)
        else:
            raise SystemExit(f"Image not found: {path}")
    if not images:
        raise SystemExit("No images to classify.")
    return images


def load_model(model_path):
    """Rebuild the exact network train.py saved and load its weights."""
    model_path = Path(model_path)
    if not model_path.is_file():
        raise SystemExit(
            f"Checkpoint not found: {model_path}\n"
            "Train one first:  python train.py --data-dir <data> --model rps_model.pt"
        )

    checkpoint = torch.load(model_path, map_location="cpu", weights_only=True)
    class_names = checkpoint["class_names"]
    arch = checkpoint.get("arch", "resnet18")

    # weights=None: no pretrained download here, the checkpoint holds everything.
    factory = ARCHITECTURES[arch]
    model = factory(weights=None)
    model.fc = nn.Linear(model.fc.in_features, len(class_names))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    preprocess = transforms.Compose(
        [
            transforms.Resize((checkpoint["img_size"], checkpoint["img_size"])),
            transforms.ToTensor(),
            transforms.Normalize(checkpoint["norm_mean"], checkpoint["norm_std"]),
        ]
    )
    return model, class_names, preprocess, checkpoint


def classify(model, preprocess, class_names, image_path):
    # convert("RGB") drops any alpha channel, which PNGs often carry.
    image = Image.open(image_path).convert("RGB")
    batch = preprocess(image).unsqueeze(0)  # add the batch dimension: CHW -> 1CHW

    with torch.no_grad():
        logits = model(batch)
        probs = torch.softmax(logits, dim=1)[0]

    best = int(probs.argmax())
    return class_names[best], float(probs[best]), probs


def main():
    args = parse_args()
    model, class_names, preprocess, checkpoint = load_model(args.model)

    print(
        f"Model: {Path(args.model).name}  "
        f"(classes: {', '.join(class_names)}; "
        f"val_acc {checkpoint.get('val_acc', 0) * 100:.2f}% "
        f"@ epoch {checkpoint.get('epoch', '?')})\n"
    )

    for image_path in collect_images(args.image):
        label, confidence, probs = classify(
            model, preprocess, class_names, image_path
        )

        print(f"{image_path.name}")
        if confidence < args.threshold:
            print(
                f"  -> no confident match "
                f"(best guess {label} at {confidence * 100:.2f}%)"
            )
        else:
            print(f"  -> {label}  ({confidence * 100:.2f}% confidence)")

        for name, prob in sorted(
            zip(class_names, probs.tolist()), key=lambda kv: -kv[1]
        ):
            print(f"     {name:<12} {prob * 100:6.2f}%")
        print()


if __name__ == "__main__":
    main()
