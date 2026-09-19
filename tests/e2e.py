"""End-to-end test of the running system.

    docker compose up -d --build
    python tests/e2e.py

Requires only `pillow` (to synthesise an upload) and the standard library.

Everything here goes through the front door on :8080, so nginx, its /api
proxy and its SPA fallback are exercised alongside the API. Nothing reaches
into a container or queries Postgres directly: if a check passes here, it
passes the way a browser would experience it.

The suite deliberately includes the failure paths. An asynchronous pipeline
that only works when everything works is the easy half; what matters is that
a bad upload still produces a terminal answer instead of a spinner that runs
forever.
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

from PIL import Image, ImageDraw

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
API = f"{APP}/api"
# Published by Compose. Used only for /health, which nginx does not proxy
# because healthchecks are an operational concern, not part of the web app.
API_DIRECT = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5000"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def make_png(size: tuple[int, int] = (300, 200)) -> bytes:
    """A synthetic hand-ish shape. The prediction is meaningless by design."""
    image = Image.new("RGB", size, (40, 160, 90))
    draw = ImageDraw.Draw(image)
    draw.ellipse((90, 50, 210, 150), fill=(224, 190, 160))
    draw.rectangle((140, 120, 165, 190), fill=(224, 190, 160))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def send(request: urllib.request.Request):
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


def get(path: str, base: str = ""):
    return send(urllib.request.Request(f"{base or API}{path}"))


def upload(filename: str, content: bytes, field: str = "image", content_type: str = "image/png"):
    boundary = f"----boundary{uuid.uuid4().hex}"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        content,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    return send(urllib.request.Request(
        f"{API}/inference",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    ))


def wait_for_terminal(request_id: str, timeout: float = 60.0):
    """Poll exactly as the browser does, and report the states passed through."""
    seen: list[str] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, job = get(f"/inference/{request_id}")
        if status != 200:
            return None, seen
        if job["status"] not in seen:
            seen.append(job["status"])
        if job["status"] in ("completed", "failed"):
            return job, seen
        time.sleep(0.4)
    return None, seen


print(f"\ntarget: {APP}")

# ---------------------------------------------------------------------------
print("\nthe happy path")
# ---------------------------------------------------------------------------
status, body = upload("gesture.png", make_png())
check("upload is accepted with 202", status == 202, f"got {status} {body}")
if status != 202:
    raise SystemExit("cannot continue without a request id")

request_id = body["requestId"]
check("a tracking id comes back immediately", bool(request_id))
check("the poll URL is included", body.get("statusUrl", "").endswith(request_id))

job, seen = wait_for_terminal(request_id)
check("the job reaches a terminal state", job is not None, f"states seen: {seen}")

if job:
    check("it completed", job["status"] == "completed", str(job.get("errorMessage")))
    prediction = job.get("prediction") or {}
    check("a prediction is attached", bool(prediction))
    check(
        "the class is one the model knows",
        prediction.get("predictedClass") in ("rock", "paper", "scissors"),
        str(prediction.get("predictedClass")),
    )
    probabilities = prediction.get("probabilities", {})
    check("the whole distribution is returned", len(probabilities) == 3, str(probabilities))
    check(
        "the probabilities sum to one",
        abs(sum(probabilities.values()) - 1.0) < 1e-4,
        str(sum(probabilities.values())),
    )
    # Postgres returns NUMERIC as a string unless a type parser is registered.
    # If that regressed, the UI would call toFixed on a string and throw.
    check(
        "confidence is a number, not a string",
        isinstance(prediction.get("confidence"), float),
        type(prediction.get("confidence")).__name__,
    )
    check("the checkpoint's provenance is recorded", prediction.get("modelArch") == "resnet18")
    check("the worker stamped started_at", job.get("startedAt") is not None)
    check("and completed_at", job.get("completedAt") is not None)
    check("the original filename survived", job.get("originalName") == "gesture.png")
    print(
        f"       -> {prediction.get('predictedClass')} at {prediction.get('confidence')} "
        f"in {prediction.get('durationMs')}ms   (states: {seen})"
    )

# ---------------------------------------------------------------------------
print("\nthe stored image, served back from S3")
# ---------------------------------------------------------------------------
status, raw = get(f"/inference/{request_id}/image")
check("the image is served", status == 200, f"got {status}")
check("and the bytes are the PNG that went in", isinstance(raw, bytes) and raw[:8] == b"\x89PNG\r\n\x1a\n")

# ---------------------------------------------------------------------------
print("\nhistory, read back out of postgres")
# ---------------------------------------------------------------------------
status, body = get("/inference?limit=5")
check("history responds", status == 200)
check("and contains the new job", any(i["requestId"] == request_id for i in body["items"]))
status, _ = get("/inference?limit=notanumber")
check("a bad limit is rejected", status == 400, f"got {status}")

# ---------------------------------------------------------------------------
print("\nvalidation")
# ---------------------------------------------------------------------------
status, body = upload("evil.png", b"MZ\x90\x00 an executable wearing a .png name")
check("a non-image is rejected on its bytes, not its name", status == 415, f"got {status} {body}")

status, body = upload("hand.png", make_png(), content_type="application/octet-stream")
check(
    "a generic content-type is still accepted (this is what curl sends)",
    status == 202,
    f"got {status} {body}",
)

status, body = upload("big.png", make_png() + b"\0" * (11 * 1024 * 1024))
check("an oversized upload is rejected", status == 413, f"got {status} {body}")

status, body = upload("x.png", make_png(), field="wrongfield")
check("an unexpected form field is rejected", status == 400, f"got {status} {body}")

status, body = get("/inference/not-a-uuid")
check("a malformed id is a 400, not a 500", status == 400, f"got {status} {body}")

status, _ = get(f"/inference/{uuid.uuid4()}")
check("an unknown id is a 404", status == 404, f"got {status}")

status, _ = get("/inference/00000000-0000-0000-0000-000000000000/image")
check("an image for an unknown id is a 404", status == 404, f"got {status}")

status, _ = get("/nope")
check("an unknown route is a 404", status == 404, f"got {status}")

# ---------------------------------------------------------------------------
print("\nthe failure path: a valid PNG header with an undecodable body")
# ---------------------------------------------------------------------------
# The backend's magic-number check passes this, so it reaches the queue and
# the worker becomes the component that has to reject it.
status, body = upload("truncated.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
check("the backend accepts it -- the header really is a PNG", status == 202, f"got {status}")

if status == 202:
    job, _ = wait_for_terminal(body["requestId"], timeout=30)
    check("the worker fails it rather than leaving it pending", job is not None and job["status"] == "failed", str(job))
    if job:
        message = job.get("errorMessage") or ""
        check("a reason is recorded for the user", bool(message))
        check("no prediction is attached to a failure", job.get("prediction") is None)
        # The technical cause belongs in the worker log, not in the browser.
        check("the reason is prose, not a python repr", "0x" not in message and "object at" not in message, message)
        print(f"       -> {message}")

# ---------------------------------------------------------------------------
print("\nnginx")
# ---------------------------------------------------------------------------
status, raw = send(urllib.request.Request(f"{APP}/history"))
check("a client-side route serves the app rather than a 404", status == 200, f"got {status}")
check("and it is the SPA shell", isinstance(raw, bytes) and b'<div id="root">' in raw)

# ---------------------------------------------------------------------------
print("\nhealth")
# ---------------------------------------------------------------------------
status, body = get("/health", base=API_DIRECT)
check("liveness is ok", status == 200 and body.get("status") == "ok", str(body))
status, body = get("/health/ready", base=API_DIRECT)
check("readiness reports ready", status == 200, str(body))
if isinstance(body, dict):
    check(
        "postgres, rabbitmq and s3 all report healthy",
        all(c["ok"] for c in body.get("checks", [])),
        str(body.get("checks")),
    )

print()
if failures:
    print(f"{len(failures)} CHECK(S) FAILED:")
    for name in failures:
        print(f"  - {name}")
    raise SystemExit(1)
print("ALL END-TO-END CHECKS PASSED")
