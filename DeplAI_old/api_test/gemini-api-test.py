import google.generativeai as genai
from dotenv import load_dotenv
import os

# Load environment variables
load_dotenv()

# Configure the API
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# List available models
print("Available Models:")
available_models = genai.list_models()
for model in available_models:
    print(model.name)

# Initialize the model
model = genai.GenerativeModel('models/gemini-2.0-pro-exp')

# Test the API with a simple prompt
print("\nTesting API with a simple prompt:")
response = model.generate_content("Yo!, this is a test message.")
print("Response:", response.text)
