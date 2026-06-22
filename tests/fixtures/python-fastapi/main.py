from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def home():
    return "hello from python-fastapi"
