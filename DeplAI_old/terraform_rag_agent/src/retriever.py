import os
import chromadb
from dotenv import load_dotenv
from pathlib import Path
from typing import List
from langchain_community.vectorstores import Chroma
from langchain_core.documents import Document
from langchain_core.runnables import Runnable

from llama_index.core import Settings
from llama_index.core.vector_stores import VectorStoreQuery
from llama_index.core.schema import NodeWithScore
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding

from utils.rag_logger import get_rag_logger

logger = get_rag_logger(__name__)

# Calculate the absolute path to the project's data directory.
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = str(BASE_DIR / "data" / "vector_db")

def get_db_retriever(
    db_path: str = os.getenv("CHROMA_DB_PATH", DEFAULT_DB_PATH),
    collection_name: str = os.getenv("CHROMA_COLLECTION", "terraform_docs"),
    embed_model_name: str = os.getenv("EMBEDDING_MODEL", "all-mpnet-base-v2")
) -> Chroma:
    """
    Initializes and returns a ChromaDB retriever.

    Args:
        db_path (str): The path to the ChromaDB database directory.
        collection_name (str): The name of the collection to use.
        embed_model_name (str): The name of the sentence-transformer model to use for embeddings.

    Returns:
        Chroma: A ChromaDB vector store object configured for retrieval.
    """
    logger.info(f"🧠 Setting up embedding model: {embed_model_name}")
    embed_model = HuggingFaceEmbedding(model_name=embed_model_name)
    Settings.embed_model = embed_model
    
    logger.info(f"🗄️ Connecting to ChromaDB collection '{collection_name}' at '{db_path}'")
    db = chromadb.PersistentClient(path=db_path)
    chroma_collection = db.get_collection(collection_name)
    
    vector_store = Chroma(
        client=db,
        collection_name=chroma_collection.name,
        embedding_function=embed_model,
    )
    logger.info("✅ ChromaDB retriever setup complete.")
    return vector_store

def setup_query_components(db_path: str, collection_name: str, embed_model_name: str):
    """Sets up the LlamaIndex query components for a specific ChromaDB collection."""
    logger.info(f"🧠 Setting up embedding model: {embed_model_name}")
    embed_model = HuggingFaceEmbedding(model_name=embed_model_name)
    Settings.embed_model = embed_model

    logger.info(f"🗄️ Connecting to ChromaDB collection '{collection_name}' at '{db_path}'")
    chroma_client = chromadb.PersistentClient(path=db_path)
    chroma_collection = chroma_client.get_collection(name=collection_name)
    
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    
    logger.info("✅ Query components setup complete.")
    return vector_store, embed_model

def main():
    """Main function to run the interactive retriever test script."""
    load_dotenv()
    logger.info("🚀 Starting Interactive RAG Retriever Test Script...")

    # 1. Connect to DB and list collections
    db_path = os.getenv("CHROMA_DB_PATH", DEFAULT_DB_PATH)
    if not Path(db_path).exists():
        logger.error(f"❌ Database path not found: {db_path}")
        return

    try:
        client = chromadb.PersistentClient(path=db_path)
        collections = client.list_collections()
        if not collections:
            logger.warning("⚠️ No collections found. The indexer might still be running. Please try again shortly.")
            return
        
        collection_names = [c.name for c in collections]
        print("\nAvailable collections:")
        for i, name in enumerate(collection_names):
            print(f"  [{i+1}] {name}")
        
        choice_input = input("Select a collection to query (number): ")
        choice = int(choice_input) - 1
        collection_name = collection_names[choice]
    except (ValueError, IndexError):
        logger.error("🔥 Invalid selection.")
        return
    except Exception as e:
        logger.error(f"🔥 Error connecting to DB: {e}")
        return

    embed_model_name = os.getenv("EMBEDDING_MODEL", "all-mpnet-base-v2")
    vector_store, embed_model = setup_query_components(db_path, collection_name, embed_model_name)

    # 2. Interactive query loop
    while True:
        print("\n" + "-"*50)
        query_text = input("Enter your search query (or 'exit' to quit): ")
        if query_text.lower() == 'exit':
            break
        if not query_text.strip():
            print("Please enter a search query.")
            continue
            
        resource_filter = input("Enter a resource name substring to filter by (e.g., 'vpc', or press Enter to skip): ").strip()

        # Generate embedding for the query
        query_embedding = embed_model.get_query_embedding(query_text)

        # Build the LlamaIndex query object
        vector_store_query = VectorStoreQuery(
            query_embedding=query_embedding,
            similarity_top_k=20, # Retrieve more results to filter them in-memory
        )

        logger.info(f"🔍 Performing vector search for '{query_text}'...")
        result = vector_store.query(vector_store_query)

        # Manually filter results in Python since ChromaDB doesn't support a 'contains' filter on metadata
        final_results = []
        if result.nodes:
            if resource_filter:
                logger.info(f"Applying in-memory filter for nodes containing '{resource_filter}' in resource_name.")
                for node in result.nodes:
                    if resource_filter in node.metadata.get("resource_name", ""):
                        final_results.append(node)
            else:
                final_results = result.nodes
        
        # Limit to top 5 after filtering
        final_results = final_results[:10]

        # 3. Display results
        if not final_results:
            print("\n--- No results found. ---")
        else:
            nodes_with_scores = []
            for node in final_results:
                # The score is associated with the original node in the `result` object
                for i, original_node in enumerate(result.nodes):
                    if node.node_id == original_node.node_id:
                        nodes_with_scores.append(NodeWithScore(node=node, score=result.similarities[i]))
                        break

            print(f"\n--- Found {len(nodes_with_scores)} relevant document(s) ---")
            for i, node in enumerate(nodes_with_scores):
                source = node.metadata.get('source', 'N/A')
                resource = node.metadata.get('resource_name', 'N/A')
                score = node.get_score()
                content_preview = node.get_content().strip().replace('\n', ' ')[:250]

                print(f"\n[{i+1}] Score: {score:.4f} | Resource: {resource} | Source: {source}")
                print(f"    Content: {content_preview}...")
    
    logger.info("👋 Exiting retriever script.")


if __name__ == "__main__":
    main() 