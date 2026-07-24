FROM python:3.14.6-alpine3.24@sha256:26730869004e2b9c4b9ad09cab8625e81d256d1ce97e72df5520e806b1709f92 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_ROOT=/app \
    PORT=8000

WORKDIR /app

RUN addgroup -S contourcast && adduser -S -G contourcast contourcast

COPY services/api/requirements-runtime.lock /tmp/requirements-runtime.lock
RUN python -m pip install --disable-pip-version-check --no-cache-dir \
    --only-binary=:all: --require-hashes --requirement /tmp/requirements-runtime.lock \
    && python -m pip check \
    && rm -rf \
        /usr/local/bin/pip* \
        /usr/local/lib/python3.13/ensurepip \
        /usr/local/lib/python3.13/html/parser.py \
        /usr/local/lib/python3.13/site-packages/pip \
        /usr/local/lib/python3.13/site-packages/pip-*.dist-info \
        /usr/local/lib/python3.13/tarfile.py

COPY services/api/app /app/app
COPY shared /app/shared
COPY contracts /app/contracts
COPY data /app/data
COPY public/data /app/public/data

USER contourcast
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '8000') + '/health', timeout=3)"]

CMD ["python", "-m", "app.server"]
