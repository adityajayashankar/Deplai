import chromadb
import os
from pathlib import Path
from dotenv import load_dotenv
from .utils.rag_logger import get_rag_logger

logger = get_rag_logger(__name__)

# Calculate the absolute path to the project's data directory to ensure correctness.
# __file__ is in .../src/, so .parent.parent is the Terraform-RAG-Model directory.
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = str(BASE_DIR / "data" / "vector_db")
DEFAULT_DOC_LIMIT = 5

def get_db_path():
    logger.debug("🔧 Loading .env for DB path...")
    load_dotenv()
    path = os.getenv("CHROMA_DB_PATH", DEFAULT_DB_PATH)
    logger.debug(f"🔩 DB path determined: {path}")
    return path

def inspect_single_collection(client: chromadb.Client, collection_name: str, limit: int = DEFAULT_DOC_LIMIT):
    """Inspects a single specified collection."""
    logger.info(f"🔎 Attempting to get collection: '{collection_name}'")
    try:
        collection = client.get_collection(name=collection_name)
        logger.info(f"✅ Successfully accessed collection '{collection_name}'.")
    except Exception as e:
         logger.error(f"🔥 Failed to get collection '{collection_name}': {e}. It might not exist or there's an issue connecting.", exc_info=True)
         return

    count = collection.count()
    logger.info(f"📊 Collection '{collection_name}' contains {count} documents.")

    if count == 0:
        logger.warning(f"⚠️ Collection '{collection_name}' is empty. No documents to inspect.")
        return

    actual_limit = min(limit, count)
    logger.info(f"🔍 Fetching {actual_limit} sample documents from '{collection_name}'...")
    
    try:
        results = collection.get(
            limit=actual_limit,
            include=["metadatas", "documents"] 
        )
    except Exception as e:
        logger.error(f"🔥 Error retrieving documents from collection '{collection_name}': {e}", exc_info=True)
        return
        
    if not results or not results.get("ids"):
         logger.warning(f"🤔 No documents retrieved from the collection '{collection_name}'.")
         return

    print(f"\n--- 📄 Sample Documents for Collection: '{collection_name}' (showing {len(results['ids'])} out of {count}) ---")
    for i in range(len(results["ids"])):
        print(f"\n🆔 Document ID: {results['ids'][i]}")
        print("📋 Metadata:")
        if results['metadatas'] and results['metadatas'][i]:
            for key, value in results['metadatas'][i].items():
                 print(f"    {key}: {value}")
        else:
            print("    No metadata found.")
        print("📜 Content (Full):")
        if results['documents'] and results['documents'][i]:
            doc_content = results['documents'][i]
            print(doc_content)
        else:
            print("    No content found.")
        print("-" * 30)

def main():
    logger.info("🚀 Starting ChromaDB Inspection Script...")
    db_path = get_db_path()
    logger.info(f"🔌 Connecting to ChromaDB at: {db_path}")
    if not os.path.exists(db_path) or not os.path.isdir(db_path):
        logger.error(f"❌ Database path does not exist or is not a directory: {db_path}")
        print(f"🚨 Please ensure ChromaDB is initialized and the path '{db_path}' is correct.")
        print("👉 You might need to run the indexer script first if no collections exist.")
        return

    try:
        client = chromadb.PersistentClient(path=db_path)
        logger.info(f"✅ Successfully connected to ChromaDB client at {db_path}.")
    except Exception as e:
        logger.error(f"🔥 Failed to connect to ChromaDB client at {db_path}: {e}", exc_info=True)
        return

    try:
        available_collections = client.list_collections()
        logger.debug("📚 Successfully listed collections.")
    except Exception as e:
        logger.error(f"🔥 Failed to list collections from ChromaDB: {e}", exc_info=True)
        return

    if not available_collections:
        logger.warning("🧐 No collections found in the database.")
        print("🤷 It seems there are no collections in ChromaDB. You may need to run the indexer script.")
        return

    collection_names = [c.name for c in available_collections]
    print("\n📚 Available collections in ChromaDB:")
    for i, name in enumerate(collection_names):
        print(f"  {i + 1}. {name}")
    print("  0. Exit")

    while True:
        try:
            choice_str = input(f"\n✍️ Enter the number of the collection to inspect (1-{len(collection_names)}, or 0 to Exit): ").strip()
            if not choice_str: 
                print("🤔 No choice made. Please enter a number or '0' to exit.")
                continue

            choice = int(choice_str)

            if choice == 0:
                logger.info("👋 Exiting inspector as per user choice.")
                print("👋 Exiting inspector.")
                break
            if 1 <= choice <= len(collection_names):
                selected_collection_name = collection_names[choice - 1]
                inspect_single_collection(client, selected_collection_name, limit=DEFAULT_DOC_LIMIT)
            else:
                print(f"❌ Invalid choice. Please enter a number between 1 and {len(collection_names)}, or 0.")
        except ValueError:
            print("🔢 Invalid input. Please enter a number.")
        except KeyboardInterrupt:
            logger.info("🛑 User interrupted the inspector. Exiting.")
            print("\n🛑 Exiting inspector due to user interrupt.")
            break
        except Exception as e:
            logger.error(f"💥 An unexpected error occurred in the main loop: {e}", exc_info=True)
            break

if __name__ == "__main__":
    main()
