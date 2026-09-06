FROM python:3.12-slim

WORKDIR /app

# Install Python dependencies
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt

# Copy the agent source
COPY . .
RUN useradd --system --uid 10001 uiux \
    && mkdir -p /app/data/uiux-runs \
    && chown -R uiux:uiux /app/data
USER uiux

# Default entrypoint
ENV AGNO_TELEMETRY=false
ENV UIUX_RUN_DIRECTORY=/app/data/uiux-runs
EXPOSE 7777

CMD ["uvicorn", "service.deep_agent_app:app", "--host", "0.0.0.0", "--port", "7777", "--workers", "1"]
