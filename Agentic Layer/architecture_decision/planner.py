from __future__ import annotations

from typing import Any

from deployment_planning_contract import (
    ArchitectureAlternative,
    ArchitectureCriticFinding,
    ArchitectureDecision,
    ArchitectureEvidence,
    AwsDiscoveryContext,
    CandidateArchitecture,
    DeploymentProfileDocument,
    RepositoryContextDocument,
)


def repository_evidence(signal: str, value: Any, confidence: float = 0.9) -> ArchitectureEvidence:
    return ArchitectureEvidence(source="repository", signal=signal, value=value, confidence=confidence)


def build_initial_decisions(context: RepositoryContextDocument, defaults: dict[str, str]) -> list[ArchitectureDecision]:
    decisions: list[ArchitectureDecision] = []
    runtime = context.language.runtime or context.language.primary
    if runtime:
        decisions.append(ArchitectureDecision(
            decision_id="application_runtime", category="workload", authority="auto", status="confirmed",
            recommendation=runtime, confidence=0.95 if context.language.confidence == "high" else 0.78,
            reason_codes=["repository:runtime_detected"],
            evidence=[repository_evidence("language.runtime", runtime, 0.95)],
        ))
    if context.health.endpoint and context.health.source != "default":
        decisions.append(ArchitectureDecision(
            decision_id="health_check_path", category="operations", authority="auto", status="confirmed",
            recommendation=context.health.endpoint, confidence=0.96,
            reason_codes=["repository:health_route"],
            evidence=[repository_evidence(f"route:{context.health.source}", context.health.endpoint, 0.96)],
        ))
    for store in context.data_stores:
        if store.type in {"postgresql", "mysql", "mariadb"}:
            decisions.extend([
                ArchitectureDecision(
                    decision_id="primary_database_engine", category="data", authority="auto", status="confirmed",
                    recommendation=store.type, confidence=0.97 if store.confidence == "high" else 0.82,
                    reason_codes=[f"repository:datastore:{store.type}"],
                    evidence=[repository_evidence(signal, store.type, 0.97) for signal in store.signals[:6]],
                ),
                ArchitectureDecision(
                    decision_id="database_private_placement", category="security", authority="auto", status="confirmed",
                    recommendation="private_subnets", confidence=1.0,
                    reason_codes=["policy:stateful_private"],
                    evidence=[ArchitectureEvidence(source="policy", signal="database_public_access", value="blocked", confidence=1.0)],
                ),
                ArchitectureDecision(
                    decision_id="database_encryption", category="security", authority="auto", status="confirmed",
                    recommendation=True, confidence=1.0, reason_codes=["policy:encryption_at_rest"],
                    evidence=[ArchitectureEvidence(source="policy", signal="rds_storage_encrypted", value=True, confidence=1.0)],
                ),
            ])
            break
    decisions.extend([
        ArchitectureDecision(
            decision_id="ebs_encryption", category="security", authority="auto", status="confirmed",
            recommendation=True, confidence=1.0, reason_codes=["policy:encryption_at_rest"],
            evidence=[ArchitectureEvidence(source="policy", signal="ebs_encrypted", value=True, confidence=1.0)],
        ),
        ArchitectureDecision(
            decision_id="administration_channel", category="security", authority="auto", status="confirmed",
            recommendation="ssm", confidence=1.0, reason_codes=["policy:no_public_ssh"],
            evidence=[ArchitectureEvidence(source="policy", signal="instance_administration", value="ssm", confidence=1.0)],
        ),
    ])
    if context.workload_profile.persistent_storage:
        item = context.workload_profile.persistent_storage[0]
        decisions.append(ArchitectureDecision(
            decision_id="durable_upload_storage", category="storage", authority="recommend_confirm",
            recommendation="s3", confidence=item.confidence,
            reason_codes=["repository:durable_local_writes"], evidence=item.evidence,
            alternatives=[ArchitectureAlternative(value="single_instance_ebs", label="Single-instance EBS", description="Lower change effort, but prevents safe horizontal scaling.", risk_delta="higher")],
        ))
    compute = defaults.get("q_compute_strategy", "ec2")
    decisions.append(ArchitectureDecision(
        decision_id="compute_strategy", category="compute", authority="recommend_confirm", recommendation=compute,
        confidence=0.88 if context.build.has_dockerfile or context.frontend.static_site_candidate else 0.74,
        reason_codes=["repository:static_site" if context.frontend.static_site_candidate else "repository:runtime_shape"],
        evidence=[repository_evidence("dockerfile", context.build.has_dockerfile, 0.96)],
        alternatives=[ArchitectureAlternative(value="ecs_fargate", label="ECS Fargate", description="Managed containers with higher baseline cost."), ArchitectureAlternative(value="ec2", label="EC2", description="Lowest-cost general compute with more operational ownership.")],
    ))
    for decision_id, category, recommendation in [
        ("environment", "business", defaults.get("q_environment")),
        ("monthly_budget", "cost", defaults.get("q_budget")),
        ("expected_usage", "scale", defaults.get("q_traffic_scale")),
        ("availability_target", "reliability", defaults.get("q_availability")),
        ("data_loss_tolerance", "reliability", defaults.get("q_data_loss")),
        ("optimization_preference", "business", defaults.get("q_optimization")),
    ]:
        decisions.append(ArchitectureDecision(
            decision_id=decision_id, category=category, authority="user_required", recommendation=recommendation,
            confidence=0.5, reason_codes=["business_intent:not_in_repository"], requires_user_input=True,
        ))
    return decisions


def resolve_decisions(decisions: list[ArchitectureDecision], answers: dict[str, str]) -> list[ArchitectureDecision]:
    answer_map = {
        "environment": "q_environment", "monthly_budget": "q_budget", "expected_usage": "q_traffic_scale",
        "availability_target": "q_availability", "data_loss_tolerance": "q_data_loss",
        "optimization_preference": "q_optimization", "compute_strategy": "q_compute_strategy",
        "durable_upload_storage": "q_upload_storage",
    }
    resolved: list[ArchitectureDecision] = []
    for item in decisions:
        copy = item.model_copy(deep=True)
        answer_key = answer_map.get(copy.decision_id)
        answer = str(answers.get(answer_key) or "").strip() if answer_key else ""
        if answer:
            original = copy.recommendation
            copy.recommendation = answer
            copy.status = "confirmed" if str(original) == answer or copy.authority == "user_required" else "overridden"
            copy.requires_user_input = False
            copy.confidence = 1.0
            copy.evidence.append(ArchitectureEvidence(source="user", signal=answer_key or copy.decision_id, value=answer, confidence=1.0))
        resolved.append(copy)
    return resolved


def estimate_candidates(profile: DeploymentProfileDocument) -> list[CandidateArchitecture]:
    has_db = any(item.type in {"postgresql", "mysql", "mariadb"} for item in profile.data_layer)
    has_redis = any(item.type == "redis" for item in profile.data_layer)
    workers = any(item.process_type == "worker" for item in profile.compute.services)
    if profile.compute.strategy == "s3_cloudfront":
        base = 8.0
    elif profile.compute.strategy == "ecs_fargate":
        base = 42.0
    else:
        base = 18.0
    base += 22.0 if has_db else 0.0
    base += 15.0 if has_redis else 0.0
    base += 10.0 if workers else 0.0
    return [
        CandidateArchitecture(id="lean", label="Lean", description="Cheapest technically viable single-region plan.", compute_strategy="ec2" if profile.compute.strategy != "s3_cloudfront" else "s3_cloudfront", estimated_monthly_usd=round(base * 0.72, 2), reliability="basic", differences=["Single-AZ stateful services", "Minimal managed ingress"]),
        CandidateArchitecture(id="recommended", label="Recommended", description="Balanced cost, security, and operability.", compute_strategy=profile.compute.strategy, estimated_monthly_usd=round(base, 2), reliability="balanced", differences=["Encrypted managed data", "Backups and baseline monitoring"]),
        CandidateArchitecture(id="high_availability", label="High availability", description="Redundant compute and data placement for stricter recovery targets.", compute_strategy="ecs_fargate" if profile.compute.strategy != "s3_cloudfront" else "s3_cloudfront", estimated_monthly_usd=round(base * 1.9, 2), reliability="high", differences=["Multi-AZ database", "Multiple compute tasks", "Managed load balancing"]),
    ]


def critique(profile: DeploymentProfileDocument, budget_usd: float) -> list[ArchitectureCriticFinding]:
    findings: list[ArchitectureCriticFinding] = []
    candidates = profile.candidate_architectures or estimate_candidates(profile)
    recommended = next((item for item in candidates if item.id == "recommended"), None)
    if recommended and recommended.estimated_monthly_usd and recommended.estimated_monthly_usd > budget_usd:
        findings.append(ArchitectureCriticFinding(
            severity="high", code="BUDGET_EXCEEDED",
            message=f"The recommended plan is estimated at ${recommended.estimated_monthly_usd:.0f}/month against a ${budget_usd:.0f}/month budget.",
            recommendation="Select the Lean candidate, remove unnecessary NAT/ALB capacity, or increase the budget.",
            affected_decisions=["compute_strategy", "network_entry", "database_high_availability"],
        ))
    session = profile.workload.session_storage
    desired = max((service.desired_count for service in profile.compute.services if service.process_type == "web"), default=1)
    if session.get("type") == "in_memory" and desired > 1:
        findings.append(ArchitectureCriticFinding(
            severity="blocking", code="STATEFUL_SESSION_SCALING_CONFLICT",
            message="The application stores sessions in process memory while the plan uses multiple web instances.",
            recommendation="Use a shared Redis session store or keep compute at one instance.", affected_decisions=["compute_scaling", "session_storage"],
        ))
    if profile.workload.persistent_storage and profile.compute.strategy == "ecs_fargate" and not profile.storage.get("durable_uploads"):
        findings.append(ArchitectureCriticFinding(
            severity="blocking", code="MISSING_DURABLE_STORAGE",
            message="Persistent local writes were detected but the container plan has no durable upload store.",
            recommendation="Configure S3/EFS before horizontal deployment.", affected_decisions=["durable_upload_storage"],
        ))
    if profile.networking.nat_gateway and budget_usd <= 75:
        findings.append(ArchitectureCriticFinding(
            severity="warning", code="NAT_LOW_BUDGET_CONFLICT",
            message="A NAT Gateway adds meaningful fixed cost to a tightly constrained plan.",
            recommendation="Use public compute with restrictive security groups or VPC endpoints if the workload permits.", affected_decisions=["network_egress"],
        ))
    if profile.workload.workers and not any(service.process_type == "worker" for service in profile.compute.services):
        findings.append(ArchitectureCriticFinding(
            severity="blocking", code="WORKER_NOT_DEPLOYED", message="A background worker was detected but is absent from the compute plan.",
            recommendation="Add an independently scalable worker service.", affected_decisions=["workload_services"],
        ))
    if profile.workload.runtime_characteristics.get("gpu_required") and profile.compute.strategy == "ecs_fargate":
        findings.append(ArchitectureCriticFinding(
            severity="high", code="GPU_COMPUTE_MISMATCH", message="Strong CUDA/GPU signals are incompatible with the selected Fargate profile.",
            recommendation="Use a GPU-backed EC2 workload or an external inference provider.", affected_decisions=["compute_strategy"],
        ))
    return findings


def apply_aws_discovery(
    profile: DeploymentProfileDocument,
    aws_context: AwsDiscoveryContext | None,
) -> DeploymentProfileDocument:
    """Attach discovery metadata and surface reuse decisions without auto-importing resources."""
    if not aws_context or aws_context.status in {"not_requested", "unavailable"}:
        return profile

    profile.aws_reuse = aws_context
    vpcs = [item for item in aws_context.resources if item.resource_type == "vpc"]
    preferred_vpc = next((item for item in vpcs if bool((item.metadata or {}).get("default"))), None)
    if preferred_vpc is None and vpcs:
        preferred_vpc = vpcs[0]

    if preferred_vpc and str(profile.networking.vpc or "").strip().lower() in {"", "new"}:
        profile.networking.vpc = preferred_vpc.resource_id
        profile.warnings.append(
            f"AWS discovery found VPC {preferred_vpc.resource_id}. Reuse requires explicit confirmation before Terraform references it.",
        )

    existing_decision_ids = {decision.decision_id for decision in profile.decisions}
    for recommendation in aws_context.reuse_recommendations[:8]:
        decision_id = f"reuse_{recommendation.resource_type}_{recommendation.resource_id}".replace("-", "_")[:56]
        if decision_id in existing_decision_ids:
            continue
        profile.decisions.append(
            ArchitectureDecision(
                decision_id=decision_id,
                category="aws_reuse",
                authority="recommend_confirm",
                status="proposed",
                recommendation=f"evaluate_reuse:{recommendation.resource_id}",
                confidence=0.85,
                reason_codes=[f"aws:{recommendation.resource_type}"],
                evidence=[
                    ArchitectureEvidence(
                        source="aws",
                        signal=f"{recommendation.resource_type}:{recommendation.resource_id}",
                        value=recommendation.reason,
                        confidence=0.85,
                    ),
                ],
            ),
        )
        existing_decision_ids.add(decision_id)

    if aws_context.permission_gaps:
        profile.warnings.append(
            f"AWS discovery completed with {len(aws_context.permission_gaps)} permission gap(s); reuse recommendations may be incomplete.",
        )
    return profile
