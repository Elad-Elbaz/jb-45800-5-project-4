# Rock / Paper / Scissors Image Classifier

Fine-tunes a pretrained **ResNet18** to classify photos of hand gestures into
**rock**, **paper** or **scissors**.

The project is deliberately split in two, and the split is the important part:

- `train.py` learns from a folder of images and writes a checkpoint.
- `predict.py` loads that checkpoint and classifies new images.

`train.py` stores the class names, the backbone name and every preprocessing
constant *inside* the checkpoint. `predict.py` reads them back out instead of
hardcoding its own copy, so the two scripts cannot fall out of sync — change the
architecture or the normalization in training and prediction follows
automatically.

---

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: source .venv/Scripts/activate
pip install -r requirements.txt
```

**A trained model (`rps_model.pt`) is committed in this repo, so you can predict
immediately without training anything:**

```bash
python predict.py --model ./rps_model.pt --image ./test_images/rock_1.png
```

To classify the whole example folder at once:

```bash
python predict.py --model ./rps_model.pt --image ./test_images
```

---

## Dataset

[Rock-Paper-Scissors Images](https://www.kaggle.com/datasets/drgfreeman/rockpaperscissors)
by Julien de la Bruère-Terreault (CC-BY-SA 4.0) — 2188 RGB `.png` images,
300×200, shot against a green background.

Download it from Kaggle, unzip it, and point `--data-dir` at the folder that
contains the three class sub-folders:

```
rps_data/
    paper/      *.png
    rock/       *.png
    scissors/   *.png
```

> **Watch the nesting.** The Kaggle zip contains the three class folders *and* a
> `rps-cv-images/` folder holding a second copy of them. Point `--data-dir` at a
> folder with **exactly** the three class folders inside — otherwise
> `rps-cv-images` is picked up as a bogus fourth class. `train.py` prints every
> class it finds before training starts, so this mistake is visible in the first
> few lines of output rather than after a wasted run.


---

## Training

```bash
python train.py --data-dir ./rps_data --epochs 8 --model ./rps_model.pt
```

| Argument | Default | Meaning |
|---|---|---|
| `--data-dir` | *(required)* | Folder with one sub-folder per class |
| `--epochs` | `8` | Number of passes over the data |
| `--model` | `rps_model.pt` | Where to write the checkpoint |
| `--arch` | `resnet18` | `resnet18`, `resnet34` or `resnet50` |
| `--batch-size` | `32` | Images per step |
| `--lr` | `1e-4` | Adam learning rate |
| `--val-split` | `0.2` | Fraction held out for validation |
| `--num-workers` | `0` | DataLoader workers (`0` is the safest default) |
| `--seed` | `42` | Makes the split and the run reproducible |

What it does: an 80/20 train/validation split, ImageNet normalization,
augmentation (flip / rotation / colour jitter) on the training split only, and
`CrossEntropyLoss` + `Adam`. Loss and validation accuracy print every epoch, and
per-epoch metrics are also written to `rps_model.history.json`.

Only the **best** epoch is saved, not the last one, so a late overfitting epoch
cannot cost you the model.

---

## Results

Command that produced the committed model:

```bash
python train.py --data-dir ./rps_data --epochs 8 --model ./rps_model.pt
```

8 epochs on CPU (12 cores), 23.5 minutes total, 1746 training / 436 validation
images.

| Epoch | train loss | train acc | val loss | val acc | saved |
|---:|---:|---:|---:|---:|:---:|
| 1 | 0.1215 | 95.88% | 0.0040 | 100.00% | ✅ |
| 2 | 0.0116 | 99.66% | 0.0030 | 100.00% | ✅ |
| 3 | 0.0044 | 99.94% | 0.0066 | 99.77% | |
| 4 | 0.0186 | 99.66% | 0.0079 | 99.77% | |
| 5 | 0.0074 | 99.71% | 0.0045 | 99.77% | |
| 6 | 0.0050 | 99.71% | 0.0078 | 99.77% | |
| 7 | 0.0071 | 99.77% | 0.0038 | 100.00% | |
| 8 | 0.0022 | 100.00% | 0.0011 | 100.00% | ✅ **best** |

**Shipped model: epoch 8 — 100.00% validation accuracy, 0.0011 validation loss.**

### Why the checkpoint is chosen on loss, not just accuracy

Validation accuracy hits 100% after the *first* epoch and never meaningfully
improves. That is not a great model so much as an easy dataset: every photo is a
hand on the same green background under the same lighting, so the classes are
close to linearly separable.

The practical consequence is that accuracy alone cannot tell you which epoch is
best — a plain "keep the highest validation accuracy" rule would have locked in
**epoch 1** and thrown away everything after it. Falling through to validation
loss as the tie-breaker keeps **epoch 8** instead, whose loss is **3.6× lower**
than epoch 2's and **36× lower** than epoch 1's. Same accuracy, much better
calibrated probabilities.

### Predictions on held-out images

These six images were moved out of the dataset *before* training, so they
appeared in neither the training nor the validation split.

```
$ python predict.py --model ./rps_model.pt --image ./test_images

paper_1.png     -> paper     (100.00%)
paper_2.png     -> paper     ( 99.99%)
rock_1.png      -> rock      ( 98.53%)
rock_2.png      -> rock      (100.00%)
scissors_1.png  -> scissors  (100.00%)
scissors_2.png  -> scissors  (100.00%)
```

**6 / 6 correct.**

### Knowing when the model does not know

`ood_test/not_a_hand.png` is coloured geometric shapes — not a hand gesture at
all. The model has only three labels available, so it must answer with one of
them; `--threshold` is what turns that into an honest "don't know":

```
$ python predict.py --model ./rps_model.pt --image ./ood_test/not_a_hand.png --threshold 0.90

not_a_hand.png
  -> no confident match (best guess rock at 66.32%)
     rock          66.32%
     scissors      19.58%
     paper         14.10%
```

66% on nonsense, against 98–100% on real gestures — the confidence gap is wide
enough for a threshold to separate them.

### Honest limitation

Every training image shares one green background. The model has therefore
learned gestures *in that setting*, and accuracy on photos taken against an
arbitrary background will be well below 100%. Fixing that needs more varied
data, not more epochs.

---

## Prediction

```bash
python predict.py --model ./rps_model.pt --image ./test_images/rock_1.png
```

| Argument | Default | Meaning |
|---|---|---|
| `--model` | `rps_model.pt` | Checkpoint written by `train.py` |
| `--image` | *(required)* | One or more image files, or a folder of images |
| `--threshold` | `0.0` | Below this confidence, report "no confident match" |

`--image` accepts several paths or a whole directory:

```bash
python predict.py --model ./rps_model.pt --image a.png b.png
python predict.py --model ./rps_model.pt --image ./test_images
```

Output is the predicted class, the confidence, and the full probability
distribution across all three classes.

---

## Project structure

```
train.py             fine-tunes ResNet18 and writes the checkpoint
predict.py           loads the checkpoint and classifies images
requirements.txt     dependencies
rps_model.pt         trained model (committed, ready to use)
test_images/         6 held-out images, never seen during training
ood_test/            one image that is not a hand gesture at all
```

---

## Notes

**The example images are genuinely unseen.** The six files in `test_images/`
were moved out of the dataset *before* training started, so they were in neither
the training nor the validation split.

**Python 3.10 or newer** is required by the pinned `torch==2.13.0`.

**Windows — handled automatically, no action needed.** PyTorch's DLLs link
against the Microsoft Visual C++ runtime, which a bare Python install on Windows
does not ship; without it `import torch` fails with
`OSError: [WinError 126] ... c10.dll`. `requirements.txt` pulls in
`msvc-runtime` on Windows only (via a `sys_platform` marker), and `train.py` and
`predict.py` add those DLLs to the loader path before importing torch.

This was verified by deleting the runtime DLLs and confirming that a bare
`import torch` fails while both scripts still run. On macOS and Linux the whole
mechanism is skipped — the marker installs nothing and the code path is inert.

If you would rather fix it system-wide, installing the
[VC++ redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) also
works and makes the shim redundant.
