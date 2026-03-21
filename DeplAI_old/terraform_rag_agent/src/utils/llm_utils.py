import os
from openai import OpenAI
from langchain_openai import ChatOpenAI
import logging

logger = logging.getLogger(__name__)

def get_llm(model_name: str = "gpt-4o", temperature: float = 0.0):
    """
    Initializes and returns a generic LLM client (OpenAI).
    This is a backend-specific utility.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable not set.")
        raise ValueError("OPENAI_API_KEY is not configured.")
    
    try:
        llm = ChatOpenAI(model_name=model_name, temperature=temperature, api_key=api_key)
        return llm
    except Exception as e:
        logger.error(f"Failed to initialize ChatOpenAI: {e}", exc_info=True)
        raise

def get_chat_llm(model_name: str = "gpt-4.1", temperature: float = 0.0):
    """
    Legacy or alternative naming. For now, it's an alias for get_llm.
    """
    return get_llm(model_name=model_name, temperature=temperature)

def get_openai_client() -> OpenAI:
    """
    Initializes and returns a raw OpenAI client for direct API calls.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable not set.")
        raise ValueError("OPENAI_API_KEY is not configured.")
    
    try:
        client = OpenAI(api_key=api_key)
        return client
    except Exception as e:
        logger.error(f"Failed to initialize OpenAI client: {e}", exc_info=True)
        raise 