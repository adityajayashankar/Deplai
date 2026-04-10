"""
Test script to verify the LLM configuration for the Terraform Agent
"""

import os
import sys
from dotenv import load_dotenv
from pathlib import Path

# Add the agent directory to the path
sys.path.append(str(Path(__file__).parent / "agent"))

# Load environment variables
load_dotenv()
load_dotenv(Path(__file__).parent / "agent" / ".env")

try:
    from models.llm_config import get_llm_client, get_model, chat_json

    # Print configuration
    print(f"Agent LLM Backend: {os.environ.get('AGENT_LLM_BACKEND', 'not set')}")
    print(f"Using model: {get_model()}")

    # Try a simple LLM test
    result = chat_json(
        system_prompt="You are a helpful assistant that responds in JSON format.",
        user_prompt="Return a JSON object with keys 'success' and 'message' where message explains which LLM provider is being used.",
    )

    print("\nTest Result:")
    print(result)
    print("\nLLM configuration test completed successfully!")

except Exception as e:
    print(f"Error testing LLM configuration: {str(e)}")
    print("\nCheck that all required packages are installed:")
    print("pip install -r requirements.txt")
