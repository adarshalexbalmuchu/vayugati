# Vayu Gati ingest + intelligence service.
# One always-on container: hourly ingestion, forecast, attribution, and the
# /classify + /intel endpoints. Deploy to Railway / Render / Fly (not serverless —
# the APScheduler cron needs a long-lived process).

FROM python:3.11-slim

# libgomp1 is required by LightGBM's runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Persistent mount point for the Geofabrik OSM .pbf extract used by
# isrm_osm_roads.py.  In production (Render/Railway/Fly), mount a
# persistent disk at /data/osm so the ~600 MB file survives container
# restarts.  The directory is created here so the service starts cleanly
# even when no disk is mounted yet — isrm_osm_roads.py returns [] until
# the file is present, without raising.
RUN mkdir -p /data/osm

# host platforms inject $PORT; default to 8000 for local `docker run`
ENV PORT=8000
EXPOSE 8000

# sh -c so $PORT still expands, JSON form so signals reach uvicorn (clean shutdown)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
