"""Base class for WebSocket-streaming runners (scan & remediation)."""

import asyncio
import contextvars
from fastapi import WebSocket

from models import StreamStatus, ScanMessage, WebSocketCommand


class CancelledError(Exception):
    pass


class RunnerBase:
    """Shared WebSocket messaging, cancellation, and step execution."""

    def __init__(self, websocket: WebSocket, total_steps: int):
        self.websocket = websocket
        self._cancelled = False
        self._message_index = 0
        self._total_steps = total_steps
        # The asyncio Task running _run_pipeline, set by the WebSocket handler
        self._task: asyncio.Task | None = None

    def cancel(self):
        """Request cancellation. Also cancels the underlying asyncio Task if set."""
        self._cancelled = True
        if self._task is not None and not self._task.done():
            self._task.cancel()

    def _check_cancelled(self):
        if self._cancelled:
            raise CancelledError()

    async def _send_message(self, msg_type: str, content: str):
        self._message_index += 1
        message = ScanMessage.create(self._message_index, self._total_steps, msg_type, content)
        try:
            await self.websocket.send_json({
                "type": "message",
                "data": message.model_dump(),
            })
        except Exception:
            # Client may disconnect while a long-running workflow is in progress.
            # Keep the runner alive; status can be recovered via REST polling.
            pass

    async def _send_status(self, status: StreamStatus):
        try:
            await self.websocket.send_json({
                "type": "status",
                "status": status.value,
            })
        except Exception:
            pass

    async def _terminate(self, message: str) -> bool:
        await self._send_message("error", message)
        await self._send_status(StreamStatus.error)
        return False

    async def _run_step(self, func):
        """Run a blocking function in an executor, checking for cancellation first."""
        self._check_cancelled()
        loop = asyncio.get_running_loop()
        ctx = contextvars.copy_context()
        return await loop.run_in_executor(None, ctx.run, func)

    async def run(self) -> bool:
        try:
            return await self._run_pipeline()
        except CancelledError:
            return False

    async def handle_command(self, command: WebSocketCommand):
        """Optional command hook for runners that support interactive actions."""
        return None

    async def _run_pipeline(self) -> bool:
        raise NotImplementedError
