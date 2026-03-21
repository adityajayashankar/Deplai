import os
from dotenv import load_dotenv
import openai

# 📥 Load environment variables
load_dotenv()

# 🔑 Configure OpenAI API
openai.api_key = os.getenv("OPENAI_API_KEY")

def test_openai_api():
    try:
        # 🤖 List available models
        print("📚 Available Models:")
        models = openai.models.list()
        for model in models.data:
            print(f"✅ - {model.id}")

        # ✨ Test the API with a simple prompt
        print("\n🚀 Testing API with a simple prompt...")
        response = openai.chat.completions.create(
            model="gpt-4.1",
            messages=[
                {"role": "user", "content": "Yo!, this is a test message."}
            ]
        )
        print("\n💬 Response:", response.choices[0].message.content)

    except Exception as e:
        print(f"❌ Error: {str(e)}")

if __name__ == "__main__":
    print("🧪 Running OpenAI API Test...\n")
    test_openai_api()
