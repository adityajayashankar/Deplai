# 1. Base Image
FROM python:3.13-slim

# 2. Install build dependencies needed for packages like NumPy
RUN apt-get update && apt-get install -y --no-install-recommends build-essential

# 3. Set Environment Variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# 4. Set Working Directory
WORKDIR /app

# 5. Install Dependencies
# First copy only the requirements to leverage Docker cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 6. Copy Application Code
COPY . .

# 7. Expose Ports
# Expose Streamlit port
EXPOSE 8501
# Expose FastAPI port (if main.py runs a web server, assuming default is 8000)
EXPOSE 8000

# 8. Default Command
CMD streamlit run streamlit_app.py --server.port $PORT --server.address 0.0.0.0 