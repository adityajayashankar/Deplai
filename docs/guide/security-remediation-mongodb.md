# MongoDB Atlas for security remediation

MongoDB is the durable journal for remediation runs. It records the run state
and redacted progress events, which lets the UI recover if the browser WebSocket
closes. It does not replace the Connector AI gateway or make an LLM call by
itself: the journal records each Master, Planner, Implementor, and Reviewer
dispatch result so a failed request can be diagnosed without exposing prompts or
credentials.

## Atlas setup

1. Create a MongoDB Atlas project for DeplAI security data and create a
   deployment. An M0 deployment is suitable only for development; select a
   production tier, backup policy, and region appropriate for the workload.
2. Under **Network Access**, allow only the egress IP address of the host that
   runs `agentic-layer`. For production, use the NAT/Elastic IP or private
   connectivity; do not use `0.0.0.0/0`.
3. Under **Database Access**, create a database user such as
   `deplai_remediation`. Grant it `readWrite` only on `deplai_security`; do not
   use an Atlas owner/admin account in the application. Store its generated
   password in the deployment secret manager.
4. In Atlas **Connect → Drivers → Python**, copy the `mongodb+srv://` URI and
   place it in the deployment secret as `MONGODB_URI`. Percent-encode special
   characters in the username/password. Never commit the URI.
5. Set the following values in `deploy/.env` (or the equivalent runtime secret
   store), then redeploy/restart `agentic-layer`:

   ```dotenv
   MONGODB_URI=mongodb+srv://deplai_remediation:REDACTED@cluster.example.mongodb.net/?retryWrites=true&w=majority
   REMEDIATION_MONGODB_DATABASE=deplai_security
   REMEDIATION_MONGODB_RETENTION_DAYS=30
   REMEDIATION_MONGODB_CHECKPOINTS=true
   REMEDIATION_MONGODB_PERSIST_CONTEXT=true
   ```

6. Run a remediation and confirm the Atlas collections `remediation_runs` and
   `remediation_events` receive documents. With both checkpoint flags enabled,
   LangGraph also creates `remediation_checkpoints` and
   `remediation_checkpoint_writes`.

## Data and safety boundary

- The journal stores run metadata and redacted, size-bounded progress events;
  it intentionally omits patch diffs and LLM credentials.
- Checkpoints contain curated source context. They are opt-in, have the same
  TTL as the run journal, and are automatically disabled for a direct BYOK key.
- The Connector’s authenticated `GET /api/remediate/status/:projectId` route
  verifies project ownership before returning this recovery status.
- Use Atlas MFA, least-privileged project roles, restricted network access, and
  a retention duration approved for your source-code handling policy.
