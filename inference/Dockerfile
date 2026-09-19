# syntax=docker/dockerfile:1

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# PyTorch's CPU kernels are OpenMP-threaded. The wheel usually carries its own
# copy, but the system library is a few hundred kilobytes and removes an
# entire class of "works on my machine" import failure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

# Torch comes from PyTorch's own CPU index, explicitly and before anything
# else. The default PyPI wheel for Linux bundles the entire CUDA runtime and
# weighs several gigabytes; there is no GPU anywhere in this compose file, so
# that would be gigabytes of image downloaded to sit unused.
#
# requirements.txt then installs cleanly on top: it pins `torch==2.13.0`, and
# a specifier without a local version matches the `2.13.0+cpu` already
# present, so pip treats it as satisfied rather than replacing it.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.13.0 torchvision==0.28.0 \
 && pip install -r requirements.txt

# The checkpoint before the source: 44 MB that changes rarely, copied in its
# own layer so editing worker.py does not re-send it on every build.
COPY rps_model.pt ./

# Only what the worker actually runs. train.py is deliberately absent -- it
# needs the dataset, which is not in the repository and not in this image.
COPY predict.py config.py storage.py database.py engine.py worker.py ./

# An unprivileged user, created after the installs that need root. The worker
# reads the model and writes nothing to the filesystem.
RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

# No EXPOSE and no healthcheck: this container serves no port. It is reachable
# only through the queue, which is the entire point of the design.
CMD ["python", "worker.py"]
