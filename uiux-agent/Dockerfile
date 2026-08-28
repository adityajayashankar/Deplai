FROM python:3.12-slim

WORKDIR /app

# Install git (required for git-patch tool)
RUN apt-get update && apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the agent source
COPY . .

# Default entrypoint
ENV AGNO_TELEMETRY=false
EXPOSE 7777

CMD ["python", "service/agent_os_app.py"]
