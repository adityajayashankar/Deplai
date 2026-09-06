"""Start scans independently of browser connections; retain bounded progress replay."""
import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from uuid import uuid4
from security_run_store import SecurityRunStore


@dataclass
class ScanJob:
    user_id: str
    run_id: str = field(default_factory=lambda: uuid4().hex)
    sequence: int = 0
    store: SecurityRunStore | None = None
    status: str = "running"
    events: deque = field(default_factory=lambda: deque(maxlen=500))
    subscribers: set = field(default_factory=set)
    task: asyncio.Task | None = None
    persistence_failed: bool = False
    _delivery_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send_json(self, payload):
        async with self._delivery_lock:
            from security_redaction import redact as _redact
            if isinstance(payload.get("data"), dict) and isinstance(payload["data"].get("content"), str):
                payload = {**payload, "data": {**payload["data"], "content": _redact(payload["data"]["content"])}}
            self.sequence += 1
            payload = {**payload, "run_id": self.run_id, "sequence": self.sequence}
            if self.store:
                try:
                    await asyncio.to_thread(self.store.event, self.run_id, payload)
                except Exception:
                    self.persistence_failed = True
                    raise
            self.events.append(payload)
            for socket in tuple(self.subscribers):
                try:
                    await asyncio.wait_for(socket.send_json(payload), timeout=3)
                except Exception:
                    self.subscribers.discard(socket)

    async def attach(self, socket):
        # Replay and live messages share a lock so an old RUNNING event cannot
        # arrive after a newer COMPLETED event during reconnection.
        async with self._delivery_lock:
            for event in self.events:
                await asyncio.wait_for(socket.send_json(event), timeout=3)
            await socket.send_json({"type": "status", "status": self.status})
            self.subscribers.add(socket)


class ScanJobs:
    def __init__(self):
        self.jobs: dict[str, ScanJob] = {}
        self.store = SecurityRunStore()

    async def snapshot(self, project_id):
        job = self.jobs.get(project_id)
        if job:
            return {"run_id": job.run_id, "status": job.status, "events": list(job.events), "user_id": job.user_id}
        run = await asyncio.to_thread(self.store.latest, project_id)
        if not run:
            return None
        return {"run_id": run["_id"], "status": run["status"], "user_id": run["user_id"],
            "events": await asyncio.to_thread(self.store.events, run["_id"])}

    def start(self, project_id, user_id, factory, on_complete):
        existing = self.jobs.get(project_id)
        if existing and existing.status == "running":
            if existing.user_id != str(user_id):
                raise PermissionError("Unauthorized")
            return existing
        # Active work is never evicted. Keep only the latest 100 settled jobs.
        settled = [key for key, job in self.jobs.items() if job.status != "running"]
        for key in settled[:-99]:
            del self.jobs[key]
        job = ScanJob(user_id=str(user_id))
        self.store.create(project_id, user_id, job.run_id)
        job.store = self.store
        runner = factory(job)
        self.jobs[project_id] = job

        async def execute():
            async def renew():
                while True:
                    await asyncio.sleep(25)
                    await asyncio.to_thread(self.store.heartbeat, project_id, job.run_id)
            lease_task = asyncio.create_task(renew())
            try:
                runner_task = asyncio.create_task(runner.run())
                done, _ = await asyncio.wait([runner_task, lease_task], return_when=asyncio.FIRST_COMPLETED)
                if lease_task in done:
                    runner_task.cancel()
                    await asyncio.gather(runner_task, return_exceptions=True)
                    lease_task.result()
                success = await runner_task
                on_complete()
                job.status = "completed" if success and not job.persistence_failed else "error"
            except asyncio.CancelledError:
                job.status = "error"
                raise
            except Exception:
                logging.getLogger(__name__).exception("Scan worker failed for project %s", project_id)
                job.status = "error"
                await job.send_json({"type": "status", "status": "error",
                                     "error": "Scan worker failed. Retry the scan or check scanner service logs."})
            finally:
                if 'runner_task' in locals() and not runner_task.done():
                    runner_task.cancel()
                    await asyncio.gather(runner_task, return_exceptions=True)
                lease_task.cancel()
                await asyncio.gather(lease_task, return_exceptions=True)
                await asyncio.to_thread(self.store.finish, project_id, job.run_id, job.status)
                await job.send_json({"type": "status", "status": job.status})

        job.task = asyncio.create_task(execute())
        runner._task = job.task
        return job
