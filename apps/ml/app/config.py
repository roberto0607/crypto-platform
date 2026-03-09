import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://cp:cp@localhost:5433/cp")
# asyncpg needs the scheme to be 'postgresql' not 'postgres'
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

ML_MODEL_PATH = os.getenv("ML_MODEL_PATH", "./models")
ML_MIN_CONFIDENCE = int(os.getenv("ML_MIN_CONFIDENCE", "70"))
PORT = int(os.getenv("PORT", "8000"))
