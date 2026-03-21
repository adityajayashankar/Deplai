import chromadb
# Settings is deprecated, remove the import
# from chromadb.config import Settings 
import os
from dotenv import load_dotenv
# Remove standard logging, import custom logger
# import logging 
from utils.rag_logger import setup_custom_logger # Import custom logger

# Initialize custom logger
logger = setup_custom_logger(__name__)

def initialize_chromadb_utility():
    """Initializes a ChromaDB client and lists existing collections."""
    
    logger.info("🚀 Starting ChromaDB Utility Script...")
    load_dotenv()
    
    db_path = os.getenv("CHROMA_DB_PATH", "./data/vector_db")
    
    logger.info(f"🔌 Attempting to connect to ChromaDB at path: {db_path}")
    
    # Ensure the parent directory for db_path exists if db_path includes subdirectories
    db_parent_dir = os.path.dirname(db_path)
    if db_parent_dir and not os.path.exists(db_parent_dir):
        logger.info(f"📂 Parent directory for ChromaDB ({db_parent_dir}) does not exist. Creating it.")
        os.makedirs(db_parent_dir, exist_ok=True)
    elif not os.path.exists(db_path): # If db_path itself is the directory to be created (e.g. './data/vector_db')
        logger.info(f"📂 ChromaDB directory ({db_path}) does not exist. Creating it.")
        os.makedirs(db_path, exist_ok=True)
    elif not os.path.isdir(db_path):
        logger.error(f"❌ ChromaDB path {db_path} exists but is not a directory. Please check the path.")
        raise NotADirectoryError(f"ChromaDB path {db_path} exists but is not a directory.")
        
    try:
        client = chromadb.PersistentClient(path=db_path)
        logger.info(f"✅ Successfully connected to ChromaDB at {db_path}.")
        
        collections = client.list_collections()
        if collections:
            collection_names = [c.name for c in collections]
            logger.info(f"📚 Available collections: {collection_names}")
        else:
            logger.info("🧐 No collections found in the database.")
            
        return client
        
    except Exception as e:
        logger.error(f"🔥 Failed to initialize or connect to ChromaDB: {e}", exc_info=True)
        raise

if __name__ == "__main__":
    try:
        client = initialize_chromadb_utility()
        if client:
            logger.info("🎉 ChromaDB utility script completed successfully.")
        else:
            logger.error("💔 ChromaDB utility script failed to complete.")
            
    except Exception as e:
        # The error should have been logged by the function, but we can add a final message
        logger.error(f"💥 ChromaDB utility script failed with an exception: {e}", exc_info=True)
        # Optionally print the full exception for debugging
        # import traceback
        # traceback.print_exc() 