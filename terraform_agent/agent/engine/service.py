from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .bundle import build_fallback_bundle, build_manifest_bundle, decide_component_strategy
from .deployment_profile import (
    build_profile_bundle,
    build_profile_manifest,
    is_deployment_profile_payload,
    validate_deployment_profile_payload,
)
from .locking import acquire_workspace_lock, release_workspace_lock
from .manifest import build_manifest
from .runtime import (
    DEFAULT_PROVIDER_CONSTRAINT,
    artifacts_dir,
    bundle_dir,
    ensure_dir,
    load_state,
    new_run_id,
    replace_tree,
    save_state,
    utc_now_iso,
)
from .storage import (
    cleanup_local_runs,
    cleanup_remote_runs,
    download_run_snapshot,
    resolve_execution_credentials,
    upload_run_snapshot,
)


NON_IDEMPOTENT_REVIEW_TYPES = {
    "aws_instance",
    "aws_launch_configuration",
    "aws_db_instance",
    "aws_s3_bucket",
}


def _context_summary(payload: dict[str, Any]) -> str:
    return str(payload.get("qa_summary") or payload.get("context_summary") or "").strip()


def _website_index_html(payload: dict[str, Any]) -> str:
    return str(payload.get("website_index_html") or "").strip() or "<html><body><h1>DeplAI deployment is live</h1></body></html>"


def _project_name(payload: dict[str, Any]) -> str:
    return str(payload.get("project_name") or payload.get("workspace") or "deplai-project").strip()


def _apply_env(payload: dict[str, Any]) -> dict[str, str]:
    env = resolve_execution_credentials(
        aws_region=str(payload.get("aws_region") or "eu-north-1"),
        aws_access_key_id=str(payload.get("aws_access_key_id") or ""),
        aws_secret_access_key=str(payload.get("aws_secret_access_key") or ""),
        aws_session_token=str(payload.get("aws_session_token") or ""),
    )
    env["TF_IN_AUTOMATION"] = "1"
    return env


def _initialize_state(payload: dict[str, Any], *, run_id: str, workspace: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "workspace": workspace,
        "provider_version": "",
        "state_bucket": str(payload.get("state_bucket") or ""),
        "lock_table": str(payload.get("lock_table") or ""),
        "components": [],
        "dag_order": [],
        "knowledge_store": {},
        "plan_attempts": [],
        "apply_result": {
            "succeeded": [],
            "failed": [],
            "state_snapshot": None,
        },
        "outputs": {
            "public": {},
            "sensitive_arns": {},
        },
        "warnings": [],
        "source": "terraform_agent",
        "phase": "init",
        "schema_version": "1.0",
        "created_at": utc_now_iso(),
        "artifacts_dir": str(artifacts_dir(workspace, run_id)),
        "bundle_dir": str(bundle_dir(workspace, run_id)),
        "project_name": _project_name(payload),
        "aws_region": str(payload.get("aws_region") or "eu-north-1"),
        "request_context": {
            "provider": str(payload.get("provider") or "aws"),
            "project_name": _project_name(payload),
            "workspace": workspace,
            "aws_region": str(payload.get("aws_region") or "eu-north-1"),
            "state_bucket": str(payload.get("state_bucket") or ""),
            "lock_table": str(payload.get("lock_table") or ""),
            "refresh_docs": bool(payload.get("refresh_docs")),
            "credential_mode": "request" if payload.get("aws_access_key_id") and payload.get("aws_secret_access_key") else "resolved_runtime",
        },
    }


def _deterministic_refine(files: dict[str, str], diagnostics: list[dict[str, Any]]) -> dict[str, str]:
    patched = dict(files)
    for diagnostic in diagnostics:
        summary = str(diagnostic.get("summary") or "")
        detail = str(diagnostic.get("detail") or "")
        text = f"{summary}\n{detail}".lower()
        if "unsupported argument" in text:
            for line in detail.splitlines():
                if '"' not in line:
                    continue
                arg = line.split('"')[1]
                for path, content in list(patched.items()):
                    patched[path] = "\n".join(
                        existing_line
                        for existing_line in content.splitlines()
                        if f"{arg} =" not in existing_line
                    )
        if "cycle" in text:
            for path, content in list(patched.items()):
                patched[path] = "\n".join(
                    existing_line for existing_line in content.splitlines() if "depends_on" not in existing_line
                )
    return patched


def _run_plan_loop(
    *,
    local_bundle_dir: Path,
    env: dict[str, str],
    state: dict[str, Any],
    request_payload: dict[str, Any],
) -> tuple[bool, dict[str, str]]:
    from .execution import extract_diagnostics, parse_json_stream, run_terraform_command

    source = "generated"
    files = {
        str(path.relative_to(local_bundle_dir).as_posix()): path.read_text(encoding="utf-8")
        for path in local_bundle_dir.rglob("*")
        if path.is_file()
    }
    for attempt_index in range(1, 4):
        init_result = run_terraform_command(local_bundle_dir, ["init", "-input=false", "-no-color"], env=env)
        plan_result = run_terraform_command(
            local_bundle_dir,
            ["plan", "-input=false", "-no-color", "-lock-timeout=300s", "-json", "-out=tfplan.bin"],
            env=env,
        )
        plan_events = parse_json_stream(plan_result["stdout"])
        diagnostics = extract_diagnostics(plan_events)
        state["plan_attempts"].append(
            {
                "attempt": attempt_index,
                "source": source,
                "diagnostics": diagnostics,
                "init_log_tail": init_result["stdout"][-2000:],
                "plan_log_tail": plan_result["stdout"][-2000:],
            }
        )
        if not diagnostics:
            state["phase"] = "planned"
            return True, files

        if source != "fallback":
            fallback_files, fallback_warnings = build_fallback_bundle(
                project_name=_project_name(request_payload),
                workspace=state["workspace"],
                provider_version=state["provider_version"],
                state_bucket=state["state_bucket"],
                lock_table=state["lock_table"],
                aws_region=state["aws_region"],
                context_summary=_context_summary(request_payload),
                website_index_html=_website_index_html(request_payload),
            )
            state["warnings"].extend(fallback_warnings)
            replace_tree(local_bundle_dir, fallback_files)
            files = fallback_files
            source = "fallback"
            state["source"] = "fallback"
            continue

        refined = _deterministic_refine(files, diagnostics)
        replace_tree(local_bundle_dir, refined)
        files = refined

    state["phase"] = "plan_failed"
    return False, files


def _write_artifact(state: dict[str, Any], name: str, payload: Any) -> None:
    artifact_root = Path(str(state["artifacts_dir"]))
    ensure_dir(artifact_root)
    (artifact_root / name).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def generate_terraform_run(request_payload: dict[str, Any]) -> dict[str, Any]:
    from .bootstrap import bootstrap_environment
    from .research import fetch_knowledge

    provider = str(request_payload.get("provider") or "aws").strip().lower()
    if provider != "aws":
        return {"success": False, "error": "Terraform agent currently supports AWS only.", "source": "unsupported"}

    workspace = str(request_payload.get("workspace") or request_payload.get("project_name") or "default").strip()
    run_id = new_run_id()
    state = _initialize_state(request_payload, run_id=run_id, workspace=workspace)
    save_state(workspace, run_id, state)
    lock_acquired = False
    offline_generation = False
    env = {
        "AWS_DEFAULT_REGION": state["aws_region"],
        "TF_IN_AUTOMATION": "1",
    }
    try:
        env = _apply_env(request_payload)
    except Exception as exc:
        offline_generation = True
        state["phase"] = "offline_generation"
        state["provider_version"] = DEFAULT_PROVIDER_CONSTRAINT
        state["warnings"].append(
            "Generated Terraform files without AWS bootstrap or live validation because no usable AWS credentials "
            f"were available. AWS access is only required later for deploy/apply. {exc}"
        )

    try:
        cleanup_local_runs()
        if not offline_generation:
            try:
                cleanup_remote_runs(env=env, state_bucket=state["state_bucket"])
                acquire_workspace_lock(env=env, lock_table=state["lock_table"], workspace=workspace, run_id=run_id)
                lock_acquired = True
                bootstrap_dir = ensure_dir(Path(state["artifacts_dir"]) / "bootstrap")
                bootstrap = bootstrap_environment(
                    bootstrap_dir=bootstrap_dir,
                    state_bucket=str(request_payload.get("state_bucket") or ""),
                    lock_table=str(request_payload.get("lock_table") or ""),
                    workspace=workspace,
                    aws_region=state["aws_region"],
                    aws_access_key_id=str(env.get("AWS_ACCESS_KEY_ID") or ""),
                    aws_secret_access_key=str(env.get("AWS_SECRET_ACCESS_KEY") or ""),
                    aws_session_token=str(env.get("AWS_SESSION_TOKEN") or ""),
                )
                state["phase"] = "profile"
                state["provider_version"] = bootstrap["provider_version"]
            except Exception as exc:
                offline_generation = True
                state["phase"] = "offline_generation"
                state["provider_version"] = DEFAULT_PROVIDER_CONSTRAINT
                state["warnings"].append(
                    "Falling back to offline Terraform generation because AWS backend bootstrap failed. "
                    f"Files were still generated, but remote state bootstrap and live validation were skipped. {exc}"
                )
        else:
            state["provider_version"] = DEFAULT_PROVIDER_CONSTRAINT

        architecture_input = request_payload["architecture_json"]
        knowledge_store: dict[str, Any] = {}
        if is_deployment_profile_payload(architecture_input):
            validation_errors = validate_deployment_profile_payload(architecture_input)
            if validation_errors:
                raise ValueError(f"deployment_profile validation failed: {'; '.join(validation_errors)}")
            manifest, dag_order = build_profile_manifest(architecture_input)
            files, warnings = build_profile_bundle(
                payload=architecture_input,
                provider_version=state["provider_version"],
                state_bucket=state["state_bucket"],
                lock_table=state["lock_table"],
                aws_region=state["aws_region"],
                context_summary=_context_summary(request_payload),
                website_index_html=_website_index_html(request_payload),
            )
            state["source"] = "deployment_profile"
        else:
            manifest, dag_order = build_manifest(architecture_input)
            unique_types = sorted({component["type"] for component in manifest if component["type"] != "aws_resource"})
            for resource_type in unique_types:
                knowledge = fetch_knowledge(
                    state["provider_version"],
                    resource_type,
                    refresh_docs=bool(request_payload.get("refresh_docs")),
                )
                knowledge_key = f"{state['provider_version']}::{resource_type}"
                knowledge_store[knowledge_key] = knowledge
            for component in manifest:
                knowledge_key = f"{state['provider_version']}::{component['type']}"
                knowledge = knowledge_store.get(knowledge_key, {})
                component["knowledge_key"] = knowledge_key if knowledge else None
                component["doc_url"] = knowledge.get("doc_url") if isinstance(knowledge, dict) else None
                component["strategy"] = decide_component_strategy(component, knowledge if isinstance(knowledge, dict) else {})
            files, warnings = build_manifest_bundle(
                project_name=_project_name(request_payload),
                workspace=workspace,
                provider_version=state["provider_version"],
                state_bucket=state["state_bucket"],
                lock_table=state["lock_table"],
                aws_region=state["aws_region"],
                context_summary=_context_summary(request_payload),
                website_index_html=_website_index_html(request_payload),
                manifest=manifest,
            )

        state["components"] = manifest
        state["dag_order"] = dag_order
        state["warnings"].extend(warnings)
        state["knowledge_store"] = knowledge_store
        local_bundle_dir = Path(str(state["bundle_dir"]))
        written_files = replace_tree(local_bundle_dir, files)
        final_files = dict(files)
        planned_ok = True
        if not offline_generation:
            planned_ok, final_files = _run_plan_loop(
                local_bundle_dir=local_bundle_dir,
                env=env,
                state=state,
                request_payload=request_payload,
            )
            written_files = [{"path": path, "content": content} for path, content in final_files.items()]
        else:
            state["phase"] = "generated_offline"

        _write_artifact(state, "manifest.json", manifest)
        _write_artifact(state, "dag_order.json", dag_order)
        _write_artifact(state, "knowledge_store.json", knowledge_store)
        save_state(workspace, run_id, state)
        if not offline_generation:
            upload_run_snapshot(env=env, state_bucket=state["state_bucket"], workspace=workspace, run_id=run_id)

        if not planned_ok:
            return {
                "success": False,
                "error": "Terraform plan failed after 3 attempts.",
                "source": state["source"],
                "run_id": None if offline_generation else run_id,
                "workspace": None if offline_generation else workspace,
                "provider_version": state["provider_version"],
                "state_bucket": state["state_bucket"],
                "lock_table": state["lock_table"],
                "manifest": manifest,
                "dag_order": dag_order,
                "warnings": state["warnings"],
                "details": {"plan_attempts": state["plan_attempts"]},
            }

        return {
            "success": True,
            "provider": provider,
            "project_name": _project_name(request_payload),
            "run_id": None if offline_generation else run_id,
            "workspace": None if offline_generation else workspace,
            "provider_version": state["provider_version"],
            "state_bucket": state["state_bucket"],
            "lock_table": state["lock_table"],
            "manifest": manifest,
            "dag_order": dag_order,
            "warnings": state["warnings"],
            "files": written_files,
            "readme": final_files.get("README.md"),
            "source": state["source"],
        }
    except Exception as exc:
        state["phase"] = "failed"
        state["warnings"].append(str(exc))
        save_state(workspace, run_id, state)
        if not offline_generation:
            try:
                upload_run_snapshot(env=env, state_bucket=state["state_bucket"], workspace=workspace, run_id=run_id)
            except Exception:
                pass
        return {
            "success": False,
            "error": str(exc),
            "source": state["source"],
            "run_id": run_id,
            "workspace": workspace,
            "state_bucket": state["state_bucket"],
            "lock_table": state["lock_table"],
            "warnings": state["warnings"],
        }
    finally:
        if lock_acquired:
            release_workspace_lock(env=env, lock_table=state["lock_table"], workspace=workspace, run_id=run_id)


def _load_run_for_apply(request_payload: dict[str, Any]) -> tuple[dict[str, Any], Path]:
    workspace = str(request_payload.get("workspace") or request_payload.get("project_name") or "default").strip()
    run_id = str(request_payload.get("run_id") or "").strip()
    if not run_id:
        raise ValueError("run_id is required for run-based Terraform apply")
    state_bucket = str(request_payload.get("state_bucket") or "").strip()
    env = _apply_env(request_payload)
    download_run_snapshot(env=env, state_bucket=state_bucket, workspace=workspace, run_id=run_id)
    state = load_state(workspace, run_id)
    local_bundle_dir = Path(str(state["bundle_dir"]))
    return state, local_bundle_dir


def _split_outputs(output_payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    public: dict[str, Any] = {}
    sensitive: dict[str, Any] = {}
    for key, value in output_payload.items():
        if not isinstance(value, dict):
            public[key] = value
            continue
        actual = value.get("value")
        if bool(value.get("sensitive")):
            sensitive[key] = actual
        else:
            public[key] = actual
    return public, sensitive


def _put_secret(secret_client: Any, name: str, value: str) -> str:
    try:
        resp = secret_client.create_secret(Name=name, SecretString=value)
        return str(resp.get("ARN") or "")
    except secret_client.exceptions.ResourceExistsException:
        desc = secret_client.describe_secret(SecretId=name)
        secret_client.put_secret_value(SecretId=name, SecretString=value)
        return str(desc.get("ARN") or "")


def apply_terraform_run(request_payload: dict[str, Any], *, apply_context: dict[str, Any] | None = None) -> dict[str, Any]:
    from .execution import (
        extract_apply_errors,
        extract_failed_resource_types,
        parse_json_stream,
        run_terraform_command,
    )
    import boto3

    state, local_bundle_dir = _load_run_for_apply(request_payload)
    env = _apply_env(request_payload)
    workspace = str(state["workspace"])
    run_id = str(state["run_id"])
    release_needed = False
    if str(state.get("lock_table") or "").strip():
        acquire_workspace_lock(env=env, lock_table=str(state["lock_table"]), workspace=workspace, run_id=run_id)
        release_needed = True

    apply_attempt = 0
    apply_events: list[dict[str, Any]] = []
    try:
        while apply_attempt < 2:
            apply_attempt += 1
            try:
                apply_result = run_terraform_command(
                    local_bundle_dir,
                    ["apply", "-input=false", "-auto-approve", "-lock-timeout=300s", "-json", "tfplan.bin"],
                    env=env,
                    apply_context=apply_context,
                )
                apply_events = parse_json_stream(apply_result["stdout"])
                break
            except Exception as exc:
                apply_events = parse_json_stream(str(exc))
                failures = extract_apply_errors(apply_events)
                failed_types = extract_failed_resource_types(failures)
                state["apply_result"]["failed"] = failures
                if any(resource_type in NON_IDEMPOTENT_REVIEW_TYPES for resource_type in failed_types):
                    state["phase"] = "apply_failed_manual_review"
                    save_state(workspace, run_id, state)
                    upload_run_snapshot(env=env, state_bucket=str(state["state_bucket"]), workspace=workspace, run_id=run_id)
                    return {
                        "success": False,
                        "error": "Terraform apply failed on non-idempotent resources and requires manual review.",
                        "details": {
                            "failed_resources": failures,
                            "failed_resource_types": failed_types,
                        },
                    }

                try:
                    show_result = run_terraform_command(
                        local_bundle_dir,
                        ["show", "-json"],
                        env=env,
                        apply_context=apply_context,
                    )
                    state_snapshot = json.loads(show_result["stdout"] or "{}")
                except Exception as show_exc:
                    state["phase"] = "apply_failed"
                    save_state(workspace, run_id, state)
                    upload_run_snapshot(env=env, state_bucket=str(state["state_bucket"]), workspace=workspace, run_id=run_id)
                    return {
                        "success": False,
                        "error": f"Terraform apply failed and state inspection failed: {show_exc}",
                        "details": {"failed_resources": failures},
                    }

                state["apply_result"]["state_snapshot"] = state_snapshot
                if not isinstance(state_snapshot, dict) or "values" not in state_snapshot or apply_attempt >= 2:
                    state["phase"] = "apply_failed"
                    save_state(workspace, run_id, state)
                    upload_run_snapshot(env=env, state_bucket=str(state["state_bucket"]), workspace=workspace, run_id=run_id)
                    return {
                        "success": False,
                        "error": f"Terraform apply failed: {exc}",
                        "details": {"failed_resources": failures, "state_snapshot": state_snapshot},
                    }

        output_result = run_terraform_command(
            local_bundle_dir,
            ["output", "-json"],
            env=env,
            apply_context=apply_context,
        )
        outputs_raw = json.loads(output_result["stdout"] or "{}")
        public_outputs, sensitive_outputs = _split_outputs(outputs_raw if isinstance(outputs_raw, dict) else {})

        import boto3
        session = boto3.session.Session(
            aws_access_key_id=str(env.get("AWS_ACCESS_KEY_ID") or ""),
            aws_secret_access_key=str(env.get("AWS_SECRET_ACCESS_KEY") or ""),
            aws_session_token=str(env.get("AWS_SESSION_TOKEN") or "") or None,
            region_name=str(env.get("AWS_DEFAULT_REGION") or state["aws_region"]),
        )
        secret_client = session.client("secretsmanager", region_name=str(env.get("AWS_DEFAULT_REGION") or state["aws_region"]))
        secret_arns: dict[str, str] = {}
        for key, value in sensitive_outputs.items():
            secret_name = f"/deplai/{workspace}/{key}"
            secret_arns[key] = _put_secret(secret_client, secret_name, json.dumps(value) if not isinstance(value, str) else value)

        state["phase"] = "completed"
        state["apply_result"]["succeeded"] = [event for event in apply_events if event.get("type") == "apply_complete"]
        state["outputs"]["public"] = public_outputs
        state["outputs"]["sensitive_arns"] = secret_arns
        save_state(workspace, run_id, state)
        upload_run_snapshot(env=env, state_bucket=str(state["state_bucket"]), workspace=workspace, run_id=run_id)

        return {
            "success": True,
            "provider": "aws",
            "project_name": str(state.get("project_name") or workspace),
            "outputs": public_outputs,
            "cloudfront_url": public_outputs.get("cloudfront_url"),
            "details": {
                "run_id": run_id,
                "workspace": workspace,
                "state_bucket": state.get("state_bucket"),
                "lock_table": state.get("lock_table"),
                "public_outputs": public_outputs,
                "sensitive_output_arns": secret_arns,
                "sensitive_keys": sorted(secret_arns),
                "apply_attempts": apply_attempt,
            },
        }
    finally:
        if release_needed:
            release_workspace_lock(env=env, lock_table=str(state["lock_table"]), workspace=workspace, run_id=run_id)
