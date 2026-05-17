FROM python:3.11-alpine
RUN pip install --no-cache-dir flask requests
WORKDIR /app
COPY app.py .
EXPOSE 8889
CMD ["python", "app.py"]
