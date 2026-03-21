import logging
import sys

# Define emoji constants
EMOJI_INFO = "ℹ️"
EMOJI_SUCCESS = "✅"
EMOJI_WARNING = "⚠️"
EMOJI_ERROR = "❌"
EMOJI_CRITICAL = "🔥"
EMOJI_CACHE = "💾"
EMOJI_RABBITMQ = "🐇"
EMOJI_AI = "🧠"
EMOJI_PROCESSING = "⚙️"
EMOJI_DEBUG = "🐞" # For debug messages

LOG_LEVEL_EMOJIS = {
    logging.DEBUG: EMOJI_DEBUG,
    logging.INFO: EMOJI_INFO,
    logging.WARNING: EMOJI_WARNING,
    logging.ERROR: EMOJI_ERROR,
    logging.CRITICAL: EMOJI_CRITICAL,
}

class EmojiFormatter(logging.Formatter):
    """
    Custom log formatter to add emojis based on log level and specific keywords.
    """
    def __init__(self, fmt=None, datefmt=None, style='%', validate=True):
        super().__init__(fmt, datefmt, style, validate)
        self.base_fmt = fmt

    def format(self, record):
        # Get the standard emoji for the log level
        log_level_emoji = LOG_LEVEL_EMOJIS.get(record.levelno, EMOJI_INFO)

        # Placeholder for specific context emoji (can be refined)
        context_emoji = ""
        message = record.getMessage().lower()

        # Simplistic context detection (can be expanded)
        if "cache" in message or (hasattr(record, 'funcName') and "cache" in record.funcName.lower()):
            context_emoji = EMOJI_CACHE + " "
        elif "rabbitmq" in message or (hasattr(record, 'funcName') and ("mq" in record.funcName.lower() or "rabbit" in record.funcName.lower())):
            context_emoji = EMOJI_RABBITMQ + " "
        elif "ai" in message or (hasattr(record, 'funcName') and "ai" in record.funcName.lower()):
            context_emoji = EMOJI_AI + " "

        # Dynamic format string
        if hasattr(record, 'funcName') and hasattr(record, 'module'):
            # Format for when funcName and module are available
            fmt = f"{log_level_emoji} {context_emoji}%(levelname)s [{record.module}:{record.funcName}] %(message)s"
        else:
            # Fallback format if funcName or module is not available
            fmt = f"{log_level_emoji} {context_emoji}%(levelname)s %(message)s"

        # Temporarily set the format string for this record
        self._style._fmt = fmt 
        
        # Let the base class do the formatting
        result = super().format(record)
        
        # Reset to original format string
        self._style._fmt = self.base_fmt 
        return result

def setup_logger(name="DEPLAI_App", level=logging.INFO, log_to_console=True):
    """
    Sets up and returns a logger instance with custom emoji formatting.
    """
    logger = logging.getLogger(name)
    
    # Prevent multiple handlers if logger is already configured
    if logger.hasHandlers():
        logger.handlers.clear()

    logger.setLevel(level)
    logger.propagate = False

    if log_to_console:
        # Create a handler for console output
        ch = logging.StreamHandler(sys.stdout)
        ch.setLevel(level)

        # Create formatter and add it to the handler
        formatter = EmojiFormatter(
            fmt='%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        ch.setFormatter(formatter)

        # Add the handler to the logger
        logger.addHandler(ch)
    
    return logger

# Example usage (can be removed or commented out in final version)
if __name__ == '__main__':
    logger = setup_logger(level=logging.DEBUG)
    logger.debug("This is a debug message with some cache context.")
    logger.info("This is an info message about rabbitmq.")
    logger.info("This is a simple info message.")
    logger.warning("This is a warning about AI processing.")
    logger.error("This is an error message.")
    logger.critical("This is a critical failure!")

    # Example to test funcName and module
    def test_function():
        logger.info("Info from test_function in logger module (cache related).")
    test_function() 
