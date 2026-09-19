# Rock / Paper / Scissors — a full-stack image classifier

Upload a photo of a hand gesture in the browser and a fine-tuned **ResNet18**
classifies it as **rock**, **paper** or **scissors**.

The interesting part is not the model — that was trained and measured in the
previous exercise and is committed here as `inference/rps_model.pt`. The
interesting part is the plumbing: **the browser never waits on the model.**
An upload is accepted, queued and answered with a tracking id in a few
milliseconds; a separate Python container does the inference whenever it gets
to it; the browser polls a database for the answer.

---

## Quick start

Docker is the only prerequisite.

```bash
docker compose up --build
```

Then open **<http://localhost:8080>**.

The first build downloads PyTorch and takes a few minutes. Afterwards it is
cached. `docker compose up` on its own is enough from then on.

| What | Where |
|---|---|
| The app | <http://localhost:8080> |
| API (direct, for `curl`) | <http://localhost:5000> |
| RabbitMQ management UI | <http://localhost:15672> — `rps` / `rps_dev_password` |

To stop: `docker compose down`. To also discard the stored predictions:
`docker compose down -v`.

> Predictions live in a named Postgres volume and survive a plain `down`. The
> uploaded **images** do not: persistence is a paid LocalStack feature, so its
> bucket starts empty every time. A history entry from a previous run
> therefore keeps its prediction but loses its thumbnail — the API answers
> `404` for that image and the card simply renders without one.

---

## Architecture — queue + database

This is **option 1** from the brief, implemented as drawn: a queue and a
database between the backend and the inference process, and no direct call
between them in either direction.

```
                        ┌──────────────────────┐
   browser ─────────────▶  frontend  (nginx)   │
                        │  React + TypeScript  │
                        └──────────┬───────────┘
                                   │  /api  (same origin, proxied)
                        ┌──────────▼───────────┐
                        │  backend  (Express)  │
                        └──┬────────┬───────┬──┘
              put image    │        │       │   publish job
            ┌──────────────┘        │       └──────────────┐
            ▼                       ▼                      ▼
   ┌─────────────────┐    ┌──────────────────┐   ┌──────────────────┐
   │ LocalStack (S3) │    │    PostgreSQL    │   │     RabbitMQ     │
   └────────┬────────┘    └─────────▲────────┘   └─────────┬────────┘
            │  get image            │  write result        │ consume
            └───────────────┐       │        ┌─────────────┘
                            ▼       │        ▼
                        ┌──────────────────────┐
                        │  worker (PyTorch)    │
                        │  ResNet18, loaded    │
                        │  once at startup     │
                        └──────────────────────┘
```

**The backend and the worker never talk to each other.** The backend has no
address for the worker and no way to call it; the worker exposes no port at
all. Everything they share passes through the queue, the bucket and the
database.

### Why this rather than the simpler options

The brief lists three ways to connect Node to Python. The other two are
simpler, and both make the same trade:

- **`spawn("python3 predict.py")` from the controller** starts a fresh
  interpreter per request, which loads PyTorch and rebuilds a ResNet18 before
  it can classify anything. That startup dwarfs the ~50 ms the inference
  itself takes. It also holds the HTTP connection open for the whole thing,
  so a burst of uploads becomes a queue of blocked sockets with a timeout at
  the end of it.
- **FastAPI doing inference in the controller** removes the process spawn but
  keeps the blocking: the request is still held open while the model runs, and
  the web server and the GPU-bound work still scale as one unit.

Splitting them means the API's latency is the cost of a database insert and a
publish, and the worker's throughput is a separate number that can be changed
independently:

```bash
docker compose up --scale worker=3
```

Three replicas compete for the same queue. RabbitMQ delivers each message to
exactly one of them, and no other service is told anything changed.

### What each piece is for

| Service | Role | Why it is there |
|---|---|---|
| `frontend` | nginx serving the React build, proxying `/api` | One origin for the browser, so no CORS and no API hostname compiled into the bundle |
| `backend` | Express + TypeScript | Validates the upload, stores it, records it, queues it. Never runs a model |
| `rabbitmq` | Message broker | Hands each job to exactly one worker, and dead-letters what fails |
| `worker` | Python + PyTorch | Owns the loaded model. Consumes jobs, writes results |
| `postgres` | Database | The record of truth the browser polls. Outlives the queue and every restart |
| `localstack` | S3 | Where the bytes live, reachable by two containers that share no filesystem |

---

## How one prediction actually flows

1. The browser `POST`s the image as `multipart/form-data` to `/api/inference`.
2. The backend checks the **magic number** — not the `Content-Type`, which the
   client supplies and can be wrong — and rejects anything that is not really
   a PNG, JPEG, WebP or BMP.
3. It generates a UUID, then performs three writes **in this order**:
   1. the image to S3, so the key the message carries already resolves;
   2. a `pending` row to Postgres, so the job the message names already exists;
   3. the message to RabbitMQ, last.
   The order is not interchangeable. A worker can pick a message up
   microseconds after it is published, so publishing earlier is a real race
   against the job's own data, not a theoretical one.
4. The publish uses a **confirm channel** and waits for the broker's
   acknowledgement. Without that, `202 Accepted` would be a claim the system
   cannot back, and a lost message would appear to the user as a spinner that
   never resolves.
5. The API answers `202 Accepted` with the request id. Total: a few
   milliseconds. The browser starts polling `/api/inference/:id`.
6. A worker takes the message, marks the row `processing`, downloads the image
   from S3, runs the forward pass, and writes the result and the `completed`
   status **in one transaction**.
7. The next poll sees `completed` and renders the prediction.

If the worker fails, the row is marked `failed` with a reason and the message
is dead-lettered to `inference.jobs.failed`, where it can be inspected in the
management UI. The browser gets a terminal answer either way — it never polls
forever.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/inference` | Upload an image (`multipart/form-data`, field `image`). Returns `202` and a request id |
| `GET` | `/api/inference/:id` | The job and, once finished, its prediction. This is what the browser polls |
| `GET` | `/api/inference?limit=20` | Recent requests, newest first |
| `GET` | `/api/inference/:id/image` | The stored image, streamed back from S3 |
| `GET` | `/health` | Liveness. Touches no dependency |
| `GET` | `/health/ready` | Readiness. Probes Postgres, RabbitMQ and S3 |

```bash
# Submit
curl -F "image=@my_hand.png" http://localhost:5000/api/inference
# {"requestId":"3f2b...","status":"pending","statusUrl":"/api/inference/3f2b..."}

# Poll
curl http://localhost:5000/api/inference/3f2b...
```

A finished job looks like this:

```json
{
  "requestId": "3f2b8c14-...",
  "status": "completed",
  "originalName": "my_hand.png",
  "createdAt": "2026-09-19T10:04:11.204Z",
  "completedAt": "2026-09-19T10:04:11.470Z",
  "errorMessage": null,
  "prediction": {
    "predictedClass": "rock",
    "confidence": 0.9853,
    "probabilities": { "paper": 0.0074, "rock": 0.9853, "scissors": 0.0073 },
    "modelArch": "resnet18",
    "modelValAcc": 1.0,
    "durationMs": 53
  }
}
```

`/health` deliberately does **not** check the database. Docker restarts a
container that fails its healthcheck, so a liveness probe wired to Postgres
would restart a perfectly healthy API every time the database hiccupped —
removing the one component still able to report what was wrong.
`/health/ready` is the endpoint that answers that question.

---

## The model

Trained in the previous exercise; the checkpoint is committed, the dataset is
not — which is what the brief asks for, since the grading run does inference
and never trains.

**Dataset.** [Rock-Paper-Scissors Images](https://www.kaggle.com/datasets/drgfreeman/rockpaperscissors)
by Julien de la Bruère-Terreault (CC-BY-SA 4.0) — 2188 RGB `.png` images,
300×200, shot against a green background.

**Result.** ResNet18 fine-tuned for 8 epochs, 1746 training / 436 validation
images: **100.00% validation accuracy, 0.0011 validation loss** (epoch 8).
Per-epoch numbers are in `inference/rps_model.history.json`.

**Why the checkpoint is chosen on loss, not accuracy.** Validation accuracy
reaches 100% after the *first* epoch and never meaningfully improves — that is
an easy dataset more than a great model, since every photo is a hand on the
same green background under the same lighting. A plain "keep the best
accuracy" rule would therefore have locked in epoch 1 and discarded everything
after it. Falling through to validation loss as the tie-break keeps epoch 8,
whose loss is **36× lower** than epoch 1's. Same accuracy, much better
calibrated probabilities.

**Honest limitation, and what the UI does about it.** Every training image
shares one green background, so accuracy on a photo taken against an arbitrary
background will be well below 100%. Worse, the model has exactly three labels
and *must* answer with one of them: a photo of a coffee cup still produces a
winner. Measured, that lands around 66% confidence against 98–100% for real
gestures, so the web UI treats anything below **90%** as *"No confident
match"* and says why, instead of confidently reporting "Rock".

### Training and predicting from the command line

Both scripts still work exactly as they did, with no queue, no database and no
Docker — they need only `torch`, `torchvision` and `pillow`:

```bash
cd inference
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python predict.py --model ./rps_model.pt --image ./some_hand.png
python predict.py --model ./rps_model.pt --image ./folder_of_images --threshold 0.9
```

To retrain you need the dataset, laid out one folder per class:

```bash
python train.py --data-dir ./rps_data --epochs 8 --model ./rps_model.pt
```

`train.py` writes the class names, the architecture and every preprocessing
constant *into* the checkpoint, and `predict.py` reads them back out rather
than keeping its own copy. The two cannot fall out of sync — and because the
worker imports `load_model` and `classify` from `predict.py` unchanged, the
browser and the command line cannot disagree about what the model says either.

---

## Running without Docker

Useful for iterating on one service. Start the infrastructure in containers
and the application on the host:

```bash
docker compose up -d postgres rabbitmq localstack

# API
cd backend && cp .env.example .env && npm install && npm run dev

# Worker  (separate terminal)
cd inference && pip install -r requirements.txt
RABBITMQ_URL=amqp://rps:rps_dev_password@localhost:5672 \
DATABASE_URL=postgresql://rps:rps_dev_password@localhost:5432/rps_db \
S3_ENDPOINT=http://localhost:4566 python worker.py

# Frontend  (separate terminal)
cd frontend && npm install && npm run dev      # http://localhost:5173
```

The Vite dev server proxies `/api` to `localhost:5000`, exactly as nginx does
in the built image, so development and production do not differ in the one
dimension most likely to hide a bug until deployment.

---

## Project layout

```
backend/                Express + TypeScript API
  src/config/env.ts       validated, typed environment
  src/controllers/        the four HTTP operations
  src/services/           database, queue (publish), S3
  src/db/schema.sql       applied by the backend on every boot
frontend/                React + TypeScript (Vite), served by nginx
  src/api/client.ts       the typed fetch layer
  src/hooks/              the polling hook
  nginx.conf              SPA routing + /api proxy
inference/               Python worker and the model
  worker.py               RabbitMQ consumer — the queue's other half
  engine.py               loads the checkpoint once, reuses predict.py
  predict.py  train.py    unchanged from the previous exercise
  rps_model.pt            the committed checkpoint (44 MB)
docker-compose.yml       all six services
```

---

## Notes on a few decisions

**Uploads are multipart, not base64 JSON.** Base64 costs a third more bytes
and would mean raising the JSON body limit to tens of megabytes for *every*
route on the server, including the ones that should never see a large body.

**The image type is decided by its first bytes.** A `Content-Type` header and
a file extension are both supplied by the client. Trusting them means a
renamed file fails three containers away, inside PyTorch, long after the
evidence of what went wrong is gone.

**The frontend's API URL is a relative path.** Vite inlines `import.meta.env`
at *build* time, so an environment variable set on the frontend container at
run time — the obvious thing to reach for — would do nothing at all; the
bundle was compiled when the image was built. Same-origin through nginx
removes the setting entirely.

**The worker retries transient failures exactly once.** S3 or Postgres being
briefly unreachable is worth another attempt; an undecodable image is not, and
retrying it forever would be a loop with no exit. The retry is counted with
AMQP's own `redelivered` flag, so no state is carried anywhere. It is
immediate rather than backed off, because sleeping in the callback would block
the heartbeat RabbitMQ uses to tell a busy worker from a dead one — a system
needing real backoff would republish to a delay queue instead.

**The database schema is applied by the backend at startup**, not by
Postgres's `docker-entrypoint-initdb.d`. That directory runs only when the
data volume is empty, so it would silently skip an already-deployed database.
Every statement in `schema.sql` is `IF NOT EXISTS`.

**Windows.** PyTorch's DLLs link against the Microsoft Visual C++ runtime,
which a bare Python install on Windows does not ship; without it `import
torch` fails with `WinError 126`. `requirements.txt` pulls in `msvc-runtime`
on Windows only, and `train.py` / `predict.py` add those DLLs to the loader
path before importing torch. `engine.py` therefore imports `predict` *before*
`torch`, and that import order is load-bearing rather than stylistic. In the
Linux container the whole mechanism is inert.

---

## Troubleshooting

**The first build takes a long time.** It is downloading PyTorch. The image
pulls the CPU-only build from PyTorch's own index rather than the default PyPI
wheel, which bundles the entire CUDA runtime and weighs several gigabytes for
hardware this project does not use.

**A prediction stays "Queued".** The worker is not consuming. `docker compose
logs worker` will say why — most often it is still loading the checkpoint, or
it cannot reach RabbitMQ. The message is durable and will be picked up when it
recovers.

**Checking the queue by hand.** The management UI at
<http://localhost:15672> shows `inference.jobs` and `inference.jobs.failed`.
A message in the latter is one the worker rejected; the matching row in
Postgres carries the reason in `error_message`.

**Everything is unhealthy on first start.** RabbitMQ boots the Erlang VM
before it listens, which takes about 20 seconds. `depends_on` is configured to
wait for the healthchecks, so the application containers start only once the
infrastructure is genuinely ready.
