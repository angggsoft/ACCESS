import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file from project root
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

HIK_HOST = os.getenv("HIK_HOST", "192.168.11.195")
HIK_PORT = int(os.getenv("HIK_PORT", "80"))
HIK_USER = os.getenv("HIK_USER", "admin")
HIK_PASS = os.getenv("HIK_PASS", "")

BASE_URL = f"http://{HIK_HOST}:{HIK_PORT}" if HIK_PORT != 80 else f"http://{HIK_HOST}"
