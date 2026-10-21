FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY static ./static
ENV DATA_DIR=/data PORT=8080 PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8080
CMD ["python", "server.py"]
