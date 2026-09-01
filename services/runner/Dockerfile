FROM python:3.12.4-slim-bookworm@sha256:a3e58f9399353be051735f09be0316bfdeab571a5c6a24fd78b92df85bcb2d85

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

RUN useradd --create-home --uid 10001 runner
WORKDIR /opt/xiling-runner

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY xiling_runner ./xiling_runner
COPY smoke.py ./smoke.py
COPY ocean_smoke.py ./ocean_smoke.py
COPY run_ocean_analysis.py ./run_ocean_analysis.py
COPY run_connector.py ./run_connector.py
COPY connector_smoke.py ./connector_smoke.py
RUN mkdir -p /workspace && chown -R runner:runner /workspace /opt/xiling-runner

USER runner
# The Node host always starts one-shot entrypoints (run_ocean_analysis.py /
# run_connector.py); no long-lived listener is exposed from the sandbox.
CMD ["python", "-c", "raise SystemExit('xiLing runner image is not meant to run a default command')"]
