import os

from utils import get_docker_client, sanitize_name, decode_output, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME

SCANNER_TIMEOUT_SECONDS = int(os.getenv("CHECKOV_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "900")))
CHECKOV_IMAGE = "bridgecrew/checkov:3.2.334"

# Checkov 3.2.334 CheckType has no docker_compose runner. Passing it as
# --framework makes Checkov exit 2 ("Invalid frameworks specified").
IAC_FRAMEWORKS = "terraform,cloudformation,arm,serverless,ansible"
CONTAINER_FRAMEWORKS = "dockerfile"
KUBERNETES_FRAMEWORKS = "kubernetes,helm"
CICD_FRAMEWORKS = "github_actions,gitlab_ci,bitbucket_pipelines,circleci_pipelines,azure_pipelines"
API_FRAMEWORKS = "openapi"


def _detect_targets(project_id: str) -> dict[str, bool]:
    """Detect whether supported security-definition files exist in the project tree."""
    try:
        output = get_docker_client().containers.run(
            "alpine",
            command=[
                "sh", "-c",
                """
root=/src/$PID
iac=0
container=0
kubernetes=0
cicd=0
api=0
if find "$root" -type f \\( -name '*.tf' -o -name '*.tf.json' -o -name '*.bicep' -o -name '*.template' -o -name 'template.yml' -o -name 'template.yaml' -o -name 'serverless.yml' -o -name 'serverless.yaml' -o -name 'playbook.yml' -o -name 'playbook.yaml' -o -name 'cdk.json' \\) 2>/dev/null | grep -q .; then
  iac=1
fi
if find "$root" -type f \\( -name 'Dockerfile' -o -name 'Dockerfile.*' -o -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name '*.dockerfile' \\) 2>/dev/null | grep -q .; then
  container=1
fi
if find "$root" -type f \\( -name 'Chart.yaml' -o -name 'kustomization.yaml' -o -name 'kustomization.yml' -o -name 'deployment.yaml' -o -name 'deployment.yml' -o -name 'statefulset.yaml' -o -name 'daemonset.yaml' -o -name 'ingress.yaml' -o -name 'service.yaml' -o -name 'service.yml' \\) 2>/dev/null | grep -q .; then
  kubernetes=1
fi
if [ -d "$root/.github/workflows" ] || [ -f "$root/.gitlab-ci.yml" ] || [ -f "$root/bitbucket-pipelines.yml" ] || [ -d "$root/.circleci" ] || [ -f "$root/azure-pipelines.yml" ] || [ -f "$root/Jenkinsfile" ]; then
  cicd=1
fi
if find "$root" -type f \\( -name 'openapi.yaml' -o -name 'openapi.yml' -o -name 'openapi.json' -o -name 'swagger.yaml' -o -name 'swagger.yml' -o -name 'swagger.json' \\) 2>/dev/null | grep -q .; then
  api=1
fi
printf 'iac=%s container=%s kubernetes=%s cicd=%s api=%s\\n' "$iac" "$container" "$kubernetes" "$cicd" "$api"
""",
            ],
            environment={"PID": project_id},
            volumes={CODEBASE_VOLUME: {"bind": "/src", "mode": "ro"}},
            remove=True,
        )
        text = decode_output(output)
        return {
            "iac": "iac=1" in text,
            "container": "container=1" in text,
            "kubernetes": "kubernetes=1" in text,
            "cicd": "cicd=1" in text,
            "api": "api=1" in text,
        }
    except Exception:
        return {
            "iac": False,
            "container": False,
            "kubernetes": False,
            "cicd": False,
            "api": False,
        }


def detect_scan_targets(project_id: str) -> dict[str, bool]:
    return _detect_targets(project_id)


def run_checkov_scan(project_name: str, project_id: str, frameworks: str, report_suffix: str) -> tuple[bool, str]:
    """Run infrastructure policy scanning for the given Checkov frameworks."""
    container = None
    try:
        filename = f"{sanitize_name(project_name)}_{project_id}_{report_suffix}"
        container = get_docker_client().containers.run(
            CHECKOV_IMAGE,
            entrypoint="/bin/sh",
            command=[
                "-c",
                (
                    "checkov -d \"/src/${PID}\" --framework \"${FW}\" "
                    "-o json --quiet --compact --skip-download --soft-fail "
                    "--skip-path node_modules --skip-path .git --skip-path .venv "
                    "--skip-path dist --skip-path .next --skip-path vendor "
                    "> \"/output/${FILE}\" 2>/tmp/checkov.err; "
                    "code=$?; "
                    "if [ \"$code\" -eq 0 ] || [ \"$code\" -eq 1 ]; then exit 0; fi; "
                    "cat /tmp/checkov.err >&2; "
                    "exit \"$code\""
                ),
            ],
            environment={"PID": project_id, "FW": frameworks, "FILE": filename},
            user="0:0",
            volumes={
                CODEBASE_VOLUME: {"bind": "/src", "mode": "ro"},
                SECURITY_REPORTS_VOLUME: {"bind": "/output", "mode": "rw"},
            },
            detach=True,
        )
        result = container.wait(timeout=SCANNER_TIMEOUT_SECONDS)
        logs = decode_output(container.logs(stdout=True, stderr=True, tail=40))
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        # Checkov: 0 = passed, 1 = failed checks found.
        if exit_code in (0, 1):
            return (True, "")
        detail = " ".join(logs.split())[:280]
        suffix = f": {detail}" if detail else ""
        return (False, f"Infrastructure scanner exited with code {exit_code}{suffix}")
    except Exception as e:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(e))


def run_iac_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    return run_checkov_scan(project_name, project_id, IAC_FRAMEWORKS, "Checkov.json")


def run_container_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    return run_checkov_scan(project_name, project_id, CONTAINER_FRAMEWORKS, "Containers.json")


def run_kubernetes_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    return run_checkov_scan(project_name, project_id, KUBERNETES_FRAMEWORKS, "Kubernetes.json")


def run_cicd_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    return run_checkov_scan(project_name, project_id, CICD_FRAMEWORKS, "Cicd.json")


def run_api_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    return run_checkov_scan(project_name, project_id, API_FRAMEWORKS, "Api.json")
