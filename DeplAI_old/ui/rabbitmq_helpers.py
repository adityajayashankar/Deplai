import pika
import json
import time
from typing import Optional
import streamlit as st # For st.sidebar.error, st.error - consider refactoring to return status/errors
from logger import setup_logger
from config import MQ_HOST, MQ_PORT, MQ_USERNAME, MQ_PASSWORD

logger = setup_logger(name="RabbitMQHelpers")

_mq_connection = None
_mq_channel = None

def get_rabbitmq_channel():
    global _mq_connection, _mq_channel

    if not _mq_connection or _mq_connection.is_closed:
        logger.info("get_rabbitmq_channel: Connection is closed or None. Attempting new connection.")
        if _mq_connection and _mq_connection.is_closed:
            logger.info("get_rabbitmq_channel: Previous connection was already marked as closed.")
        _mq_connection = None
        _mq_channel = None
        try:
            credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
            parameters = pika.ConnectionParameters(
                host=MQ_HOST,
                port=MQ_PORT,
                credentials=credentials,
                connection_attempts=3,
                retry_delay=2,
                heartbeat=300 # Keep the connection alive
            )
            _mq_connection = pika.BlockingConnection(parameters)
            _mq_channel = _mq_connection.channel()
            _mq_channel.exchange_declare(exchange='direct_exchange', exchange_type='direct', durable=True)
            logger.info("get_rabbitmq_channel: New RabbitMQ connection and channel established.")
            return _mq_channel
        except Exception as e:
            # Using st.sidebar.error here makes this module UI-dependent.
            # Consider returning an error status/message for the caller to handle.
            st.sidebar.error(f"New RabbitMQ connection failed: {e}") 
            logger.error(f"get_rabbitmq_channel: New RabbitMQ connection failed: {e}")
            _mq_connection = None
            _mq_channel = None
            return None

    if not _mq_channel or _mq_channel.is_closed:
        logger.info("get_rabbitmq_channel: Connection is open, but channel is closed or None. Attempting new channel.")
        if _mq_channel and _mq_channel.is_closed:
             logger.info("get_rabbitmq_channel: Previous channel was already marked as closed.")
        _mq_channel = None
        try:
            _mq_channel = _mq_connection.channel()
            _mq_channel.exchange_declare(exchange='direct_exchange', exchange_type='direct', durable=True)
            logger.info("get_rabbitmq_channel: New channel established on existing connection.")
            return _mq_channel
        except Exception as e:
            st.sidebar.error(f"New channel on existing connection failed: {e}. Closing connection.")
            logger.error(f"get_rabbitmq_channel: New channel on existing connection failed: {e}. Closing connection.")
            try:
                if _mq_connection and _mq_connection.is_open:
                    _mq_connection.close()
            except Exception as e_close:
                logger.error(f"get_rabbitmq_channel: Error closing connection after failed channel create: {e_close}")
            _mq_connection = None
            _mq_channel = None
            return None
    return _mq_channel

def publish_to_rabbitmq(queue_name: str, routing_key: str, exchange_name: str, payload: dict, reply_to: str, correlation_id: str) -> bool:
    channel = get_rabbitmq_channel()
    if not channel:
        st.error("Cannot publish to RabbitMQ: Channel not available.") # UI-dependent
        logger.error("publish_to_rabbitmq: Cannot publish to RabbitMQ: Channel not available.")
        return False
    try:
        channel.basic_publish(
            exchange=exchange_name,
            routing_key=routing_key,
            body=json.dumps(payload),
            properties=pika.BasicProperties(
                delivery_mode=2,  # make message persistent
                content_type='application/json',
                reply_to=reply_to,
                correlation_id=correlation_id
            )
        )
        logger.info(f" [x] Sent message to {exchange_name} with routing key {routing_key}, CID: {correlation_id[:8]}")
        return True
    except Exception as e:
        st.error(f"Failed to publish to RabbitMQ: {e}") # UI-dependent
        logger.error(f"publish_to_rabbitmq: Failed to publish to RabbitMQ: {e}")
        return False

def consume_from_reply_queue(reply_queue_name: str, correlation_id: str, timeout_seconds: int = 60) -> Optional[dict]:
    start_time = time.time()
    response_data = None
    current_channel = None 

    logger.info(f"Attempting to consume from {reply_queue_name} for CID {correlation_id[:8]} (timeout: {timeout_seconds}s)")

    while time.time() - start_time < timeout_seconds:
        if not current_channel or not current_channel.is_open:
            logger.info(f"Consume: Channel for {reply_queue_name} is not open or None. Attempting to get/refresh channel.")
            current_channel = get_rabbitmq_channel()
            if not current_channel or not current_channel.is_open:
                logger.warning(f"Consume: RabbitMQ channel still not available or closed for {reply_queue_name}. Waiting briefly. CID: {correlation_id[:8]}")
                time.sleep(2)
                continue
            logger.info(f"Consume: Acquired/Refreshed channel for {reply_queue_name}. CID: {correlation_id[:8]}")

        try:
            try:
                current_channel.queue_declare(queue=reply_queue_name, passive=True)
            except pika.exceptions.ChannelClosedByBroker as e_passive_declare_closed:
                logger.warning(f"Consume: ChannelClosedByBroker during passive queue declare for {reply_queue_name}. Forcing channel refresh. CID: {correlation_id[:8]}. Error: {e_passive_declare_closed}")
                current_channel = None
                time.sleep(1)
                continue
            except pika.exceptions.AMQPChannelError as e_passive_declare:
                st.error(f"Consume: Reply queue {reply_queue_name} may not exist or channel error. CID: {correlation_id[:8]}. Error: {e_passive_declare}") # UI-dependent
                logger.error(f"Consume: Reply queue {reply_queue_name} may not exist or channel error during passive declare. CID: {correlation_id[:8]}. Error: {e_passive_declare}")
                return {"error": f"Reply queue {reply_queue_name} not found or channel error.", "details": str(e_passive_declare)}

            method_frame, properties, body = current_channel.basic_get(queue=reply_queue_name, auto_ack=False)

            if method_frame:
                msg_cid = properties.correlation_id if properties and properties.correlation_id else "N/A"
                logger.debug(f"[{reply_queue_name}] Got a message. DeliveryTag: {method_frame.delivery_tag}, CID_Msg: {msg_cid[:8]}, Expected_CID: {correlation_id[:8]}")
                
                if properties and properties.correlation_id == correlation_id:
                    logger.info(f"  [+] CID Match for {correlation_id[:8]}. Body (first 150 chars): {body[:150].decode(errors='ignore')}...")
                    try:
                        response_data = json.loads(body.decode())
                        current_channel.basic_ack(delivery_tag=method_frame.delivery_tag)
                        logger.info(f"  [+] Acked msg for {correlation_id[:8]}.")
                        break 
                    except json.JSONDecodeError as jde:
                        full_body_for_error = body.decode(errors='ignore')
                        st.error(f"Consume: JSONDecodeError for {correlation_id[:8]}: {jde}. Body: {full_body_for_error}") # UI-dependent
                        logger.error(f"  [-] JSONDecodeError for {correlation_id[:8]}. Nacking. Body: {full_body_for_error}")
                        current_channel.basic_nack(delivery_tag=method_frame.delivery_tag, requeue=False)
                        return {"error": f"JSON decode error from reply queue: {jde}", "raw_response": full_body_for_error}
                else:
                    logger.warning(f"  [-] CID Mismatch or no props for expected {correlation_id[:8]}. Discarding msg with CID {msg_cid[:8]}. Nacking.")
                    current_channel.basic_nack(delivery_tag=method_frame.delivery_tag, requeue=False)
            else:
                time.sleep(0.2)

        except pika.exceptions.ChannelClosedByBroker as e_broker:
            st.warning(f"Consume: RabbitMQ channel closed by broker for {reply_queue_name} (CID: {correlation_id[:8]}). Will attempt channel refresh. Error: {e_broker}") # UI-dependent
            logger.warning(f"Consume: RabbitMQ channel closed by broker for {reply_queue_name} (CID: {correlation_id[:8]}). Error: {e_broker}")
            current_channel = None
            time.sleep(1)
        except pika.exceptions.ConnectionClosedByBroker as e_conn_broker:
            st.warning(f"Consume: RabbitMQ connection closed by broker for {reply_queue_name} (CID: {correlation_id[:8]}). Will attempt connection refresh. Error: {e_conn_broker}") # UI-dependent
            logger.warning(f"Consume: RabbitMQ connection closed by broker for {reply_queue_name} (CID: {correlation_id[:8]}). Error: {e_conn_broker}")
            current_channel = None 
            _mq_connection = None # Nullify global connection as well
            time.sleep(1)
        except Exception as e:
            st.error(f"Consume: Unexpected error for {correlation_id[:8]} in {reply_queue_name}: {type(e).__name__} - {e}") # UI-dependent
            logger.error(f"Consume: Unexpected error for {correlation_id[:8]} in {reply_queue_name}: {type(e).__name__} - {e}", exc_info=True)
            return {"error": f"Unexpected error in consume_from_reply_queue: {str(e)}"}

    if response_data:
        logger.info(f"Successfully consumed and decoded msg for CID {correlation_id[:8]}.")
        return response_data
    else:
        st.warning(f"Timeout: No matching data received on {reply_queue_name} for CID {correlation_id[:8]} after {timeout_seconds}s.") # UI-dependent
        logger.warning(f"Timeout: No matching data received on {reply_queue_name} for CID {correlation_id[:8]} after {timeout_seconds}s.")
        return None 