FROM python:3.14.6-slim-bookworm@sha256:86f975aca15cf04a40b399eebede9aea7c82eae084d1f1a0a6ef6bcaae871a30 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_ROOT=/app \
    PORT=8000

WORKDIR /app

RUN addgroup --system contourcast && adduser --system --ingroup contourcast contourcast

COPY services/api/requirements-runtime.lock /tmp/requirements-runtime.lock
RUN python -m pip install --disable-pip-version-check --no-cache-dir \
    --only-binary=:all: --require-hashes --requirement /tmp/requirements-runtime.lock

COPY services/api/app /app/app
COPY shared /app/shared
COPY contracts /app/contracts
COPY data /app/data
COPY public/data /app/public/data

USER contourcast
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '8000') + '/health', timeout=3)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
