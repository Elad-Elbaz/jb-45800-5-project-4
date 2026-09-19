"""Fine-tune a pretrained ResNet on a folder-per-class image dataset.

Built for the Rock / Paper / Scissors dataset (3 classes), but works for any
dataset shaped as:

    <data-dir>/
        <class_a>/ *.png
        <class_b>/ *.png
        ...

Example:
    python train.py --data-dir ./rps_data --epochs 8 --model ./rps_model.pt

The checkpoint written by this script stores the class names and every
preprocessing constant alongside the weights, so predict.py can rebuild an
identical model without being told anything about how training was configured.
"""

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    # PyTorch's DLLs link against the Microsoft Visual C++ runtime, which a
    # bare Python install on Windows does not ship -- without it `import torch`
    # dies with "WinError 126 ... c10.dll". requirements.txt pulls in
    # msvc-runtime on Windows, which drops those DLLs inside the venv; this
    # points torch's loader at them. No-op on macOS and Linux.
    for _dll_dir in (Path(sys.prefix) / "Scripts", Path(sys.prefix)):
        if (_dll_dir / "msvcp140.dll").is_file():
            os.add_dll_directory(str(_dll_dir))

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Subset
from torchvision import datasets, models, transforms

# Preprocessing constants. These are saved into the checkpoint so that
# predict.py normalizes exactly the way training did.
IMG_SIZE = 224
NORM_MEAN = [0.485, 0.456, 0.406]  # ImageNet statistics, required by the
NORM_STD = [0.229, 0.224, 0.225]   # pretrained ResNet weights.

ARCHITECTURES = {
    "resnet18": (models.resnet18, models.ResNet18_Weights.IMAGENET1K_V1),
    "resnet34": (models.resnet34, models.ResNet34_Weights.IMAGENET1K_V1),
    "resnet50": (models.resnet50, models.ResNet50_Weights.IMAGENET1K_V1),
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Train an image classifier by fine-tuning a pretrained ResNet."
    )
    parser.add_argument(
        "--data-dir",
        default=os.path.join(".", "rps_data"),
        help="Folder containing one sub-folder per class.",
    )
    parser.add_argument(
        "--epochs", type=int, default=5, help="Number of training epochs."
    )
    parser.add_argument(
        "--model",
        default="rps_model.pt",
        help="Where to write the trained checkpoint.",
    )
    parser.add_argument(
        "--arch",
        default="resnet18",
        choices=sorted(ARCHITECTURES),
        help="Backbone architecture.",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument(
        "--val-split",
        type=float,
        default=0.2,
        help="Fraction of the data held out for validation.",
    )
    parser.add_argument(
        "--num-workers",
        type=int,
        default=0,
        help="DataLoader worker processes. 0 is the safest default on Windows/macOS.",
    )
    parser.add_argument("--seed", type=int, default=42)

    # Calibration levers. Both change the effective network structure, and
    # both are recorded in the checkpoint so a run can be identified later.
    parser.add_argument(
        "--freeze-backbone",
        action="store_true",
        help="Train only the final layer and leave the pretrained features fixed.",
    )
    parser.add_argument(
        "--no-pretrained",
        action="store_true",
        help="Start from random weights instead of ImageNet ones.",
    )
    return parser.parse_args()


def set_seed(seed):
    """Make the split, the shuffling and the weight init reproducible."""
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def pick_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    # Apple Silicon.
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def build_transforms():
    """Augment the training split; leave the validation split clean."""
    train_tf = transforms.Compose(
        [
            transforms.Resize((IMG_SIZE, IMG_SIZE)),
            transforms.RandomHorizontalFlip(),
            transforms.RandomRotation(15),
            transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2),
            transforms.ToTensor(),
            transforms.Normalize(NORM_MEAN, NORM_STD),
        ]
    )
    eval_tf = transforms.Compose(
        [
            transforms.Resize((IMG_SIZE, IMG_SIZE)),
            transforms.ToTensor(),
            transforms.Normalize(NORM_MEAN, NORM_STD),
        ]
    )
    return train_tf, eval_tf


def build_loaders(data_dir, batch_size, val_split, num_workers, seed):
    """Split one folder-per-class dataset into augmented train / clean val loaders.

    Two ImageFolder instances are opened over the same root so that the two
    splits can carry different transforms. They are then narrowed to disjoint
    index sets, which keeps a validation image from ever being augmented.
    """
    data_dir = Path(data_dir)
    if not data_dir.is_dir():
        raise SystemExit(f"--data-dir is not a folder: {data_dir}")

    train_tf, eval_tf = build_transforms()
    train_source = datasets.ImageFolder(data_dir, transform=train_tf)
    val_source = datasets.ImageFolder(data_dir, transform=eval_tf)

    total = len(train_source)
    if total == 0:
        raise SystemExit(f"No images found under {data_dir}")

    indices = list(range(total))
    random.Random(seed).shuffle(indices)
    n_val = int(round(total * val_split))
    val_idx, train_idx = indices[:n_val], indices[n_val:]
    if not train_idx or not val_idx:
        raise SystemExit(
            f"--val-split {val_split} leaves an empty split for {total} images."
        )

    train_loader = DataLoader(
        Subset(train_source, train_idx),
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
    )
    val_loader = DataLoader(
        Subset(val_source, val_idx),
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
    )
    return train_loader, val_loader, train_source.classes, train_source


def build_model(arch, num_classes, device, pretrained=True, freeze_backbone=False):
    """Load the backbone, then swap the 1000-way head for our own."""
    factory, weights = ARCHITECTURES[arch]
    model = factory(weights=weights if pretrained else None)

    if freeze_backbone:
        # Turn the pretrained network into a fixed feature extractor. Done
        # before fc is replaced, so the new head still trains.
        for param in model.parameters():
            param.requires_grad = False

    model.fc = nn.Linear(model.fc.in_features, num_classes)
    return model.to(device)


def run_epoch(model, loader, criterion, device, optimizer=None):
    """One pass over `loader`. Trains when an optimizer is supplied."""
    training = optimizer is not None
    model.train(training)

    running_loss = 0.0
    correct = 0
    seen = 0

    with torch.set_grad_enabled(training):
        for images, labels in loader:
            images, labels = images.to(device), labels.to(device)

            # predict -> loss -> zero_grad -> backward -> step
            outputs = model(images)
            loss = criterion(outputs, labels)
            if training:
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()

            running_loss += loss.item() * labels.size(0)
            correct += (outputs.argmax(dim=1) == labels).sum().item()
            seen += labels.size(0)

    return running_loss / seen, correct / seen


def describe_dataset(source, classes, n_train, n_val):
    """Print what was actually found on disk.

    This is the guard against the classic surprise-nesting bug: if --data-dir
    points one level too high, a wrapper folder shows up here as a bogus class.
    """
    per_class = {name: 0 for name in classes}
    for _, label in source.samples:
        per_class[classes[label]] += 1

    print(f"Found {len(source)} images in {len(classes)} classes:")
    for name in classes:
        print(f"  {name:<20} {per_class[name]:>5}")
    print(f"Split: {n_train} train / {n_val} validation\n")


def main():
    args = parse_args()
    set_seed(args.seed)

    device = pick_device()
    print(f"Device: {device}")

    train_loader, val_loader, classes, source = build_loaders(
        args.data_dir, args.batch_size, args.val_split, args.num_workers, args.seed
    )
    describe_dataset(
        source, classes, len(train_loader.dataset), len(val_loader.dataset)
    )

    model = build_model(
        args.arch,
        len(classes),
        device,
        pretrained=not args.no_pretrained,
        freeze_backbone=args.freeze_backbone,
    )
    criterion = nn.CrossEntropyLoss()

    # Frozen parameters have requires_grad=False; handing them to the
    # optimizer would raise, so only the trainable ones go in.
    trainable = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.Adam(trainable, lr=args.lr)

    total_tensors = sum(1 for _ in model.parameters())
    print(
        f"Config: arch={args.arch}  pretrained={not args.no_pretrained}  "
        f"freeze_backbone={args.freeze_backbone}  epochs={args.epochs}  lr={args.lr}"
    )
    print(f"Training {len(trainable)} of {total_tensors} parameter tensors.\n")

    model_path = Path(args.model)
    model_path.parent.mkdir(parents=True, exist_ok=True)

    best_acc = -1.0
    best_loss = float("inf")
    best_epoch = 0
    history = []
    started = time.time()

    for epoch in range(1, args.epochs + 1):
        epoch_start = time.time()
        train_loss, train_acc = run_epoch(
            model, train_loader, criterion, device, optimizer
        )
        val_loss, val_acc = run_epoch(model, val_loader, criterion, device)
        elapsed = time.time() - epoch_start

        print(
            f"Epoch {epoch:>2}/{args.epochs}  "
            f"loss {train_loss:.4f}  acc {train_acc * 100:5.2f}%  |  "
            f"val_loss {val_loss:.4f}  val_acc {val_acc * 100:5.2f}%  "
            f"({elapsed:.0f}s)"
        )
        history.append(
            {
                "epoch": epoch,
                "train_loss": round(train_loss, 4),
                "train_acc": round(train_acc, 4),
                "val_loss": round(val_loss, 4),
                "val_acc": round(val_acc, 4),
            }
        )

        # Keep the best-validating epoch rather than whatever the last one
        # happens to be, so a late overfitting epoch cannot cost us the model.
        # On an easy dataset val_acc saturates at 100% early and stops
        # discriminating, so ties fall through to the lower validation loss --
        # the more confident model of two that are both perfectly accurate.
        if val_acc > best_acc or (val_acc == best_acc and val_loss < best_loss):
            best_acc, best_loss, best_epoch = val_acc, val_loss, epoch
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "class_names": classes,
                    "arch": args.arch,
                    "img_size": IMG_SIZE,
                    "norm_mean": NORM_MEAN,
                    "norm_std": NORM_STD,
                    "epoch": epoch,
                    "val_acc": val_acc,
                    "val_loss": val_loss,
                    "pretrained": not args.no_pretrained,
                    "freeze_backbone": args.freeze_backbone,
                },
                model_path,
            )
            print(f"           saved new best -> {model_path}")

    total_min = (time.time() - started) / 60
    print(
        f"\nDone in {total_min:.1f} min. "
        f"Best epoch {best_epoch}: "
        f"val_acc {best_acc * 100:.2f}%, val_loss {best_loss:.4f}."
    )
    print(f"Checkpoint: {model_path.resolve()}")

    history_path = model_path.with_suffix(".history.json")
    history_path.write_text(json.dumps(history, indent=2), encoding="utf-8")
    print(f"Per-epoch metrics: {history_path.resolve()}")


if __name__ == "__main__":
    main()
