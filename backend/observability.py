import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from langfuse import Langfuse, get_client

langfuse = Langfuse()


def get_langfuse():
    return get_client()
