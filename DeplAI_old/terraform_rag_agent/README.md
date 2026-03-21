# Terraform RAG Agent for DeplAI

This directory contains the Retrieval-Augmented Generation (RAG) agent, a core component of the DeplAI system. It is a specialized microservice responsible for taking a structured JSON architecture plan and generating validated, deploy-ready Terraform HCL code.

## Overview

This agent is designed to be run as a worker process that listens to a RabbitMQ queue for architecture plans. It is not intended to be run as a standalone script.

It uses:
- **LangChain & OpenAI GPT Models**: To orchestrate the RAG pipeline. The agent reasons about the architecture plan, queries its knowledge base, and generates HCL code one resource at a time.
- **ChromaDB**: As a vector store for its knowledge base, which contains scraped and processed documentation from the official Terraform AWS provider.
- **Self-Correction Loop**: The agent validates its own generated code. If errors are found, it uses a planning and correction loop to fix the code before finalizing its output.
- **Redis**: For optional caching of LLM responses to improve performance on repeated requests.

## Features

- Converts a structured JSON architecture plan into valid Terraform code.
- Leverages an up-to-date knowledge base of Terraform AWS provider documentation.
- Generates a complete set of configuration files (`main.tf`, `variables.tf`, `outputs.tf`).
- Automatically generates a `README.md` for the generated infrastructure.
- Packages all artifacts, including user-provided code (e.g., for S3 websites), into a final output directory.

## Getting Started

For detailed instructions on setting up the environment, populating the knowledge base, and running the agent as a worker, please see the **[How to Run Guide](howtorun.md)**.

## Project Structure

```
terraform_rag_agent/
├── README.md             # This file
├── howtorun.md           # Detailed setup and run instructions
├── requirements.txt      # Project dependencies
├── db/                   # Directory for ChromaDB database storage
├── src/                  # Source code for the agent
│   ├── agent/            # Core agent logic
│   │   ├── orchestrator.py # Main agent orchestrator
│   │   ├── planner.py      # Decomposes requests into plans
│   │   ├── prompts.py      # System prompts for the LLMs
│   │   └── tools/          # Agent tools (code generation, validation, etc.)
│   ├── ingestion/        # Scripts and modules for data ingestion
│   │   └── indexer.py    # Scrapes docs and populates the DB
│   └── utils/            # Utility functions
└── .env.example          # Example environment variable file
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Terraform AWS provider documentation
- OpenAI API
- LangChain & ChromaDB communities 