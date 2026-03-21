from __future__ import annotations
import os
import re
from typing import Type, Any, Optional
from pathlib import Path

from langchain.pydantic_v1 import BaseModel, Field
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import SentenceTransformerEmbeddings

from utils.rag_logger import get_rag_logger
from .base import BaseTool
from retriever import get_db_retriever

logger = get_rag_logger(__name__)

class RAGInputArgs(BaseModel):
    query: str = Field(
        description=(
            "Must be a descriptive search query that includes the full resource name. "
            "For example, to find the arguments for an AWS VPC, use a query like "
            "'aws_vpc resource arguments' or 'what are the arguments for aws_vpc'."
        )
    )

class TerraformDocumentationRAGTool(BaseTool):
    """A tool for searching Terraform documentation."""
    name: str = "terraform_documentation_rag"
    description: str = (
        "Searches the curated Terraform provider documentation. Use this for finding "
        "syntax, attributes, and examples for specific Terraform resources."
    )
    args_schema: Type[BaseModel] = RAGInputArgs

    # Configuration fields
    db_path: str
    collection_name: str
    embedding_model_name: str = "all-mpnet-base-v2"
    top_k: int = 5
    
    # Internal state
    vectorstore: Optional[Chroma] = None

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **data: Any):
        super().__init__(**data)
        self.vectorstore = self._initialize_vectorstore()
        logger.info(
            f"🛠️ {self.name} initialized. DB: '{self.db_path}', "
            f"Collection: '{self.collection_name}', Top K: {self.top_k}"
        )

    def _initialize_vectorstore(self) -> Optional[Chroma]:
        if not Path(self.db_path).exists():
            logger.error(f"❌ ChromaDB path does not exist: {self.db_path}")
            return None
        try:
            embedding_function = SentenceTransformerEmbeddings(
                model_name=self.embedding_model_name,
                model_kwargs={'device': 'cpu'},
                cache_folder=os.getenv('SENTENCE_TRANSFORMERS_HOME')
            )
            return Chroma(
                collection_name=self.collection_name,
                persist_directory=self.db_path,
                embedding_function=embedding_function,
            )
        except Exception as e:
            logger.error(f"🔥 Failed to initialize Chroma vector store: {e}", exc_info=True)
            return None

    def _extract_resource_from_query(self, query: str) -> Optional[str]:
        match = re.search(r'\b(aws|azurerm|google|kubernetes)_[a-z0-9_]+\b', query)
        return match.group(0) if match else None

    def _run(self, query: str) -> str:
        """Use the tool."""
        if not self.vectorstore:
            return "RAG Tool Error: Vector store not available."

        try:
            docs = self.vectorstore.similarity_search_with_score(query=query, k=100)
            if not docs:
                return "No documents found."

            resource_filter = self._extract_resource_from_query(query)
            final_docs = docs
            if resource_filter:
                filtered = [
                    (doc, score) for doc, score in docs 
                    if resource_filter == doc.metadata.get("resource_name")
                ]
                if filtered:
                    final_docs = filtered
            
            final_docs.sort(key=lambda x: (x[1], x[0].metadata.get('doc_type') != 'resource'), reverse=True)
            final_docs = final_docs[:self.top_k]

            results = []
            for i, (doc, score) in enumerate(final_docs):
                marker = "[BEST MATCH] " if resource_filter and resource_filter == doc.metadata.get("resource_name") else ""
                results.append(
                    f"{i+1}. {marker}Source: {doc.metadata.get('source', 'N/A')} | "
                    f"Type: {doc.metadata.get('doc_type', 'N/A')} | "
                    f"Resource: {doc.metadata.get('resource_name', 'N/A')} (Score: {score:.4f})\n"
                    f"   Content: {doc.page_content[:400].strip()}..."
                )
            
            return f"Found {len(results)} relevant document(s):\n\n" + "\n\n".join(results)
        except Exception as e:
            logger.error(f"🔥 Error during RAG execution: {e}", exc_info=True)
            return f"An unexpected error occurred in the RAG tool: {e}"

if __name__ == '__main__':
    from dotenv import load_dotenv
    # Go up from the tool's location (src/agent/tools) to the module root
    module_root = Path(__file__).resolve().parent.parent.parent
    dotenv_path = module_root / '.env'
    load_dotenv(dotenv_path=dotenv_path)
    print(f"Attempted to load .env file from: {dotenv_path} for direct tool testing.")

    import logging
    logging.basicConfig(level=logging.INFO)
    logger.setLevel(logging.INFO)

    # Corrected default_db_path to point to Terraform-RAG-Model/data/vector_db/
    default_db_path = module_root / "data" / "vector_db"
    test_db_path = os.getenv("CHROMA_DB_PATH", str(default_db_path))
    test_collection_name = os.getenv("CHROMA_COLLECTION_NAME", "aws_provider_docs") 

    print(f"Testing TerraformDocumentationRAGTool with DB path: {test_db_path}")
    print(f"Using collection: {test_collection_name}")

    if not os.path.exists(test_db_path) or not os.path.isdir(test_db_path):
        print(f"ERROR: ChromaDB path for testing '{test_db_path}' does not exist or is not a directory. Please create it or run the indexer.")
    else:
        try:
            rag_tool = TerraformDocumentationRAGTool(
                db_path=test_db_path,
                collection_name=test_collection_name
            )
            print(f"Tool details: {rag_tool}")
            
            test_query = "aws_vpc resource arguments"
            input_data = RAGInputArgs(query=test_query)
            
            print(f"\nExecuting tool with query: '{test_query}'")
            result = rag_tool.execute(input_data)
            print("\nResult from RAG tool:")
            print(result)

        except Exception as e:
            print(f"Error during direct tool test: {e}")
            import traceback
            traceback.print_exc() 