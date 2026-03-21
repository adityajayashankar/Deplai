import logging
import sys
import os # Added for path operations

# --- Emoji Logger Setup ---
EMOJI_DEBUG = "🐞"
EMOJI_INFO = "ℹ️"
EMOJI_WARNING = "⚠️"
EMOJI_ERROR = "❌"
EMOJI_CRITICAL = "🔥"
EMOJI_SUCCESS = "✅"
EMOJI_SELENIUM = "🌐"
EMOJI_DB = "🗄️"
EMOJI_FILE = "📄"
EMOJI_CONFIG = "⚙️"
EMOJI_NETWORK = "📡" # For network operations in general
EMOJI_PROCESSING = "⚙️" # General processing

LOG_LEVEL_EMOJIS = {
    logging.DEBUG: EMOJI_DEBUG,
    logging.INFO: EMOJI_INFO,
    logging.WARNING: EMOJI_WARNING,
    logging.ERROR: EMOJI_ERROR,
    logging.CRITICAL: EMOJI_CRITICAL,
}

class EmojiFormatter(logging.Formatter):
    def __init__(self, fmt=None, datefmt=None, style='%', validate=True):
        super().__init__(fmt, datefmt, style, validate)
        # self.base_fmt and self.datefmt are implicitly handled by super()

    def format(self, record):
        log_level_emoji = LOG_LEVEL_EMOJIS.get(record.levelno, EMOJI_INFO)
        
        context_emoji = ""
        msg_lower = str(record.msg).lower()
        # func_name_lower = record.funcName.lower() # Not used in current context emoji logic

        # Context emoji logic based on message content
        if "selenium" in msg_lower or "webdriver" in msg_lower or "fetching document" in msg_lower or "url" in msg_lower:
            context_emoji = EMOJI_SELENIUM + " "
        elif "chromadb" in msg_lower or "database" in msg_lower or "collection" in msg_lower or "storing document" in msg_lower:
            context_emoji = EMOJI_DB + " "
        elif "mapper" in msg_lower or "file" in msg_lower or "directory" in msg_lower :
            context_emoji = EMOJI_FILE + " "
        elif "config" in msg_lower or "setup" in msg_lower or "embedding model" in msg_lower or "initialize" in msg_lower:
            context_emoji = EMOJI_CONFIG + " "
        elif "network" in msg_lower or "http" in msg_lower:
            context_emoji = EMOJI_NETWORK + " "
        elif "process" in msg_lower or "generate" in msg_lower or "update" in msg_lower :
            context_emoji = EMOJI_PROCESSING + " "

        # Use super().format() to get the standard formatted message (including timestamp, levelname, etc.)
        # This is more efficient than creating a new Formatter instance each time.
        original_formatted_message = super().format(record)
        
        final_message = f"{log_level_emoji} {context_emoji}{original_formatted_message}"
        
        # super().format(record) already handles appending exception information if record.exc_info is present.
        return final_message

def get_rag_logger( # Renamed from setup_custom_logger
    name: str = "TerraformRAG", 
    level: int = logging.INFO,
    log_file: str | None = None,
    log_to_console: bool = True,
    log_directory: str = "logs" # Default log directory
):
    logger_instance = logging.getLogger(name)
    
    if logger_instance.hasHandlers():
        logger_instance.handlers.clear()
        
    logger_instance.setLevel(level)
    
    # Default format string, can be customized if needed when calling the function
    # The EmojiFormatter's __init__ will receive this.
    default_fmt = '%(asctime)s - %(levelname)s - [%(module)s:%(funcName)s:%(lineno)d] - %(message)s'
    default_datefmt = '%Y-%m-%d %H:%M:%S'
    
    formatter = EmojiFormatter(
        fmt=default_fmt,
        datefmt=default_datefmt
    )
    
    if log_to_console:
        ch = logging.StreamHandler(sys.stdout) 
        ch.setLevel(level)
        ch.setFormatter(formatter)
        logger_instance.addHandler(ch)

    if log_file:
        if not os.path.exists(log_directory):
            try:
                os.makedirs(log_directory, exist_ok=True) # exist_ok=True prevents error if dir exists
                # print(f"ℹ️ Created log directory: {log_directory}") # Cannot use logger here yet
            except OSError as e:
                print(f"❌ Error creating log directory {log_directory}: {e}. File logging will be disabled.")
                log_file = None # Disable file logging if directory creation fails

        if log_file: # Check again in case it was disabled
            try:
                file_handler = logging.FileHandler(os.path.join(log_directory, log_file), mode='a', encoding='utf-8')
                file_handler.setLevel(level)
                file_handler.setFormatter(formatter)
                logger_instance.addHandler(file_handler)
            except Exception as e:
                print(f"❌ Error setting up file handler for {os.path.join(log_directory, log_file)}: {e}")


    logger_instance.propagate = False # Prevent logging from propagating to the root logger
    return logger_instance

if __name__ == '__main__':
    # Example usage:
    # Define a logs directory relative to this script for the example
    script_dir = os.path.dirname(os.path.abspath(__file__))
    example_log_dir = os.path.join(script_dir, "logs_example") # Use a specific dir for example

    # Test case 1: Console only
    logger_console = get_rag_logger(name="ConsoleOnlyLogger", level=logging.DEBUG, log_to_console=True, log_file=None)
    logger_console.info("--- Testing Console-Only Logger ---")
    logger_console.debug("This is a debug message for console only.")
    logger_console.info("Info message for console only (file operations).")

    # Test case 2: File only
    logger_file = get_rag_logger(name="FileOnlyLogger", level=logging.INFO, log_to_console=False, log_file="file_only.log", log_directory=example_log_dir)
    logger_file.info("--- Testing File-Only Logger ---")
    logger_file.info("This message should only be in file_only.log.")
    logger_file.warning("A warning just for the file.")

    # Test case 3: Both console and file
    logger_both = get_rag_logger(name="CombinedLogger", level=logging.DEBUG, log_to_console=True, log_file="combined_app.log", log_directory=example_log_dir)
    logger_both.info("--- Testing Combined (Console & File) Logger ---")
    logger_both.debug("This is a debug message for testing the logger setup (both).")
    logger_both.info("Info message about file operations (both).")
    logger_both.info("Info message: WebDriver is setting up (both).")
    logger_both.warning("Warning: A network issue detected during config (both).")
    logger_both.error("Error in database processing (both).")
    logger_both.critical("Critical system failure during Selenium operation! (both)")

    def another_function():
        # Using the 'CombinedLogger' for this example, but could get a new one
        logger_fn = get_rag_logger("AnotherFunctionLogger", level=logging.INFO, log_file="another_func.log", log_directory=example_log_dir)
        logger_fn.info("Logging from another_function to show module/func context.")
        try:
            1 / 0
        except ZeroDivisionError:
            logger_fn.error("Error in another_function!", exc_info=True)
    
    another_function()
    
    logger_both.info(f"Example logs have been written (if file logging was enabled) to directory: {example_log_dir}") 