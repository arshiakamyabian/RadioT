#!/usr/bin/env bash
# Creates apps/worker/ml/.venv with everything analyze.py needs (about 1.1 GB, plus ~0.5 GB of
# model weights downloaded on first use into ~/.cache). Needs uv (https://docs.astral.sh/uv/).
set -euo pipefail
cd "$(dirname "$0")"
export UV_NO_CACHE=1
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
uv pip install --python .venv/bin/python --no-build-isolation -r requirements-build.txt
# All-In-One without NATTEN (which does not build against current PyTorch on macOS):
# shims/natten provides the four ops it uses.
uv pip install --python .venv/bin/python --no-deps allin1==1.1.0
.venv/bin/python test_natten_shim.py
echo "ML environment ready: set ML_PYTHON=$(pwd)/.venv/bin/python in apps/worker/.env"
