import redis
import hashlib
import json
import os # For environment variables
from config import REDIS_HOST, REDIS_PORT # Import host and port from config
from logger import setup_logger # Import the logger

# Initialize logger for this module
logger = setup_logger(name="RedisCache") # Use a specific name for this logger instance

# Global variable to hold the Redis connection pool
_redis_pool = None

def get_redis_connection():
    """Establishes and returns a Redis connection using a connection pool."""
    global _redis_pool
    if _redis_pool is None:
        try:
            # logger.info(f"Attempting to create Redis connection pool to {REDIS_HOST}:{REDIS_PORT}") # Replaced by specific log below
            _redis_pool = redis.ConnectionPool(host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=False)
            # Test connection by trying to get a connection and pinging
            r = redis.Redis(connection_pool=_redis_pool)
            r.ping()
            logger.info(f"💾 Redis connection pool created and PING successful to {REDIS_HOST}:{REDIS_PORT}.") # MODIFIED
        except redis.exceptions.ConnectionError as e:
            logger.error(f"🔥 Failed to connect to Redis at {REDIS_HOST}:{REDIS_PORT}: {e}", exc_info=True) # MODIFIED
            _redis_pool = None # Ensure pool is None if connection failed
            # Optionally, re-raise the exception or handle it as per application's requirements
            # For now, we'll let it return None, and calling functions must handle it.
    
    if _redis_pool:
        try:
            return redis.Redis(connection_pool=_redis_pool)
        except Exception as e: # Catch any other potential errors when creating Redis instance from pool
            logger.error(f"🔥 Failed to create Redis instance from pool: {e}", exc_info=True)
            return None
    return None

def generate_cache_key(prefix: str, data: any) -> str:
    """Generates a consistent cache key using MD5 hash."""
    # Convert complex data types to a JSON string, sorted for consistency
    try:
        if isinstance(data, (dict, list, tuple, set)):
            serialized_data = json.dumps(data, sort_keys=True, ensure_ascii=False)
        elif isinstance(data, (str, int, float, bool)) or data is None:
            serialized_data = str(data)
        else:
            # For other types, use a generic string representation
            # Consider if specific serialization is needed for custom objects
            serialized_data = repr(data)
    except Exception as e:
        print(f"Error serializing data for cache key generation: {e}. Using repr().")
        serialized_data = repr(data) # Fallback
        
    hasher = hashlib.md5()
    hasher.update(serialized_data.encode('utf-8'))
    return f"{prefix}:{hasher.hexdigest()}"

def get_cache(key: str):
    """Gets a value from Redis cache. Returns None if key not found or error."""
    r = get_redis_connection()
    if not r:
        # Fallback or error for no Redis connection is handled by the calling function (get_cache)
        logger.warning("get_cache: No Redis connection available.") # MODIFIED
        return None
    try:
        cached_value = r.get(key)
        if cached_value:
            # print(f"Cache HIT for key: {key}") # Replaced by logger
            logger.info(f"🎯 Cache HIT for key: {key}") # MODIFIED
            # Values are stored as binary, need to decode from utf-8 then parse JSON
            return json.loads(cached_value.decode('utf-8'))
        else:
            # print(f"Cache MISS for key: {key}") # Replaced by logger
            logger.info(f"💨 Cache MISS for key: {key}") # MODIFIED
            return None
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis GET error for key {key}: {e}", exc_info=True) # MODIFIED
        return None
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error for cached value with key {key}: {e}. Value: {cached_value[:100]}...", exc_info=True) # MODIFIED with value snippet
        # Potentially delete the malformed key from cache
        try:
            r.delete(key)
            logger.warning(f"Deleted malformed cache key: {key} due to JSONDecodeError.")
        except redis.exceptions.RedisError as del_e:
            logger.error(f"Failed to delete malformed cache key {key}: {del_e}", exc_info=True)
        return None
    except Exception as e: # Catch any other unexpected errors
        logger.error(f"Unexpected error in get_cache for key {key}: {e}", exc_info=True)
        return None

def set_cache(key: str, value: any, expiration_seconds: int = 3600):
    """Sets a value in Redis cache with an expiration time."""
    r = get_redis_connection()
    if not r:
        logger.warning("set_cache: No Redis connection available. Cannot set cache.") # MODIFIED
        return False # Indicate failure
    try:
        # Serialize value to JSON string, then encode to bytes for Redis
        json_value = json.dumps(value)
        r.setex(key, expiration_seconds, json_value.encode('utf-8'))
        # print(f"Cache SET for key: {key}, expiration: {expiration_seconds}s") # Replaced by logger
        logger.info(f"💾 Cache SET for key: {key}, expiration: {expiration_seconds}s") # MODIFIED
        return True
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis SET error for key {key}: {e}", exc_info=True) # MODIFIED
        return False
    except TypeError as e: # Catch JSON serialization errors
        logger.error(f"JSON serialization error for key {key} during set_cache: {e}", exc_info=True)
        return False
    except Exception as e: # Catch any other unexpected errors
        logger.error(f"Unexpected error in set_cache for key {key}: {e}", exc_info=True)
        return False

def delete_cache(key: str):
    """Deletes a key from Redis cache."""
    r = get_redis_connection()
    if not r:
        logger.warning("delete_cache: No Redis connection available. Cannot delete cache key.") # MODIFIED
        return False
    try:
        r.delete(key)
        logger.info(f"🗑️ Cache DELETED for key: {key}") # MODIFIED
        return True
    except redis.exceptions.RedisError as e:
        logger.error(f"Redis DELETE error for key {key}: {e}", exc_info=True) # MODIFIED
        return False
    except Exception as e: # Catch any other unexpected errors
        logger.error(f"Unexpected error in delete_cache for key {key}: {e}", exc_info=True)
        return False

# Example usage (can be removed or kept for testing)
if __name__ == '__main__':
    conn = get_redis_connection()
    if conn:
        print("Successfully obtained Redis connection for testing.")
        test_data_dict = {"name": "test_user", "id": 123, "prefs": ["a", "b"]}
        test_data_str = "simple_string_test"
        
        # Test with dictionary
        key1 = generate_cache_key("test_dict", test_data_dict)
        print(f"Generated key for dict: {key1}")
        set_cache(key1, {"result": "some_ai_output_for_dict"}, 60)
        retrieved1 = get_cache(key1)
        print(f"Retrieved for dict key: {retrieved1}")

        # Test with simple string
        key2 = generate_cache_key("test_str", test_data_str)
        print(f"Generated key for string: {key2}")
        set_cache(key2, {"result": "some_ai_output_for_string"}, 60)
        retrieved2 = get_cache(key2)
        print(f"Retrieved for string key: {retrieved2}")
        
        # Test non-existent key
        retrieved_non_existent = get_cache("non_existent_key")
        print(f"Retrieved for non_existent_key: {retrieved_non_existent}")
        
        # Test delete
        if retrieved2:
            delete_cache(key2)
            retrieved_after_delete = get_cache(key2)
            print(f"Retrieved for string key after delete: {retrieved_after_delete}")
    else:
        print("Failed to obtain Redis connection for testing.") 