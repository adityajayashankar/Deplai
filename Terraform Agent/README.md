# Terraform Agent

## Overview
The Terraform Agent is a microservice that generates infrastructure-as-code (Terraform) files from repository context using LLM models. It analyzes the tech stack of a codebase and produces appropriate Terraform configurations.

## Recent Fixes

### API Authentication Issue Fix
The Terraform agent was encountering HTTP 403 errors when attempting to call the Groq API. The following changes have been implemented to resolve this issue:

1. Updated `models/llm_config.py` to support multiple LLM providers:
   - Added support for Groq, OpenAI, Anthropic (Claude), and OpenRouter
   - Created a fallback mechanism if the primary provider fails
   - Added better error handling for API calls

2. Created proper environment configuration:
   - Added a comprehensive `.env` file with all necessary API keys
   - Updated `.env.template` with explanatory comments
   - Added environment variable documentation

3. Updated Docker configuration:
   - Modified `docker-compose.yml` to include Terraform Agent environment files
   - Exposed LLM configuration variables to the agent

4. Added testing capabilities:
   - Created `test_llm_config.py` to verify LLM configuration is working
   - Added better error logging and diagnostics

## Installation

### Prerequisites
- Python 3.8+
- Docker and Docker Compose (for containerized deployment)

### Setup
1. Install required Python packages:
   ```
   pip install -r requirements.txt
   ```

2. Configure environment variables:
   - Copy `.env.template` to `.env` and fill in your API keys
   - Ensure `AGENT_LLM_BACKEND` is set to your preferred provider (`openrouter`, `groq`, `anthropic`, or `openai`)

## Testing
To test the LLM configuration:
```
python test_llm_config.py
```

## Deployment
To deploy with Docker:
1. Ensure your `.env` file is properly configured
2. Run `docker-compose up -d` from the project root
3. The Terraform Agent will be available through the Agentic Layer

## Restart Instructions
If you're experiencing issues with the Terraform Agent, follow these steps:

1. Stop the current containers:
   ```
   docker-compose down
   ```

2. Rebuild the containers:
   ```
   docker-compose build
   ```

3. Start the services:
   ```
   docker-compose up -d
   ```

4. Check the logs to ensure the services started correctly:
   ```
   docker-compose logs -f
   ```

## Troubleshooting

### HTTP 403 Errors from Groq API
If you're still seeing HTTP 403 errors:
1. Verify your API key is correct in the `.env` file
2. Try switching to a different LLM provider by setting `AGENT_LLM_BACKEND=openrouter` in your `.env` file
3. Check that the model name is valid for the chosen provider
4. Run the test script to verify API connectivity

### Package Installation Issues
If you're seeing import errors for packages like `openai`, `dotenv`, or `langgraph`:
1. Make sure you've installed the requirements:
   ```
   pip install -r requirements.txt
   ```
2. Check your Python path includes the agent directory

## Next Steps
1. Implement the Terraform generation plan from `Terraform-generation-plan.md`
2. Add state locking to prevent corruption (highest priority from the plan)
3. Develop a module-based architecture as outlined in the plan