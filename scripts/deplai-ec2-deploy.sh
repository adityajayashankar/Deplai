#!/usr/bin/env bash
# DeplAI EC2 blueprint: clone or unpack a repo, install runtime, start it, proxy :80.
#
# Run on Amazon Linux 2023 (SSM or SSH) as root:
#   sudo bash deplai-ec2-deploy.sh --repo https://github.com/org/app.git --port 3000
#   sudo bash deplai-ec2-deploy.sh --dir /opt/app --kind node
#   sudo bash deplai-ec2-deploy.sh --s3 s3://bucket/app.tgz --kind node
#
# Optional: --branch main --subdir frontend --token ghp_... --secret-arn arn:aws:secretsmanager:...
# RDS: omit --secret-arn and the script picks the first instance's MasterUserSecret.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

REPO_URL="${REPO_URL:-}"
S3_URI="${S3_URI:-}"
APP_ROOT="${APP_ROOT:-/opt/app}"
APP_SUBDIR="${APP_SUBDIR:-.}"
APP_PORT="${APP_PORT:-3000}"
APP_KIND="${APP_KIND:-auto}"
BRANCH="${BRANCH:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
DATABASE_SECRET_ARN="${DATABASE_SECRET_ARN:-}"
BUILD_COMMAND="${BUILD_COMMAND:-}"
START_COMMAND="${START_COMMAND:-}"
APP_NAME="${APP_NAME:-deplai-app}"
SKIP_BUILD=0

usage() {
  sed -n '2,12p' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --s3) S3_URI="$2"; shift 2 ;;
    --dir|--root) APP_ROOT="$2"; shift 2 ;;
    --subdir) APP_SUBDIR="$2"; shift 2 ;;
    --port) APP_PORT="$2"; shift 2 ;;
    --kind) APP_KIND="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --token) GITHUB_TOKEN="$2"; shift 2 ;;
    --secret-arn) DATABASE_SECRET_ARN="$2"; shift 2 ;;
    --build) BUILD_COMMAND="$2"; shift 2 ;;
    --start) START_COMMAND="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

LOG=/var/log/deplai-ec2-deploy.log
exec > >(tee -a "$LOG") 2>&1
echo "=== deplai-ec2-deploy $(date -Is) ==="

if [ -n "$APP_SUBDIR" ] && [ "$APP_SUBDIR" != "." ]; then
  APP_DIR="$APP_ROOT/$APP_SUBDIR"
else
  APP_DIR="$APP_ROOT"
fi

ensure_pkgs() {
  dnf install -y git nginx tar gzip unzip python3 python3-pip
  command -v aws >/dev/null 2>&1 || dnf install -y awscli || true
  systemctl enable --now amazon-ssm-agent || true
}

ensure_swap() {
  if swapon --show | grep -q .; then
    return 0
  fi
  if [ ! -f /swapfile ]; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
}

clone_or_unpack() {
  mkdir -p "$(dirname "$APP_ROOT")"
  if [ -n "$S3_URI" ]; then
    aws s3 cp "$S3_URI" /tmp/deplai-app.tgz
    rm -rf "$APP_ROOT"
    mkdir -p "$APP_DIR"
    tar -xzf /tmp/deplai-app.tgz -C "$APP_DIR"
    return 0
  fi
  if [ -n "$REPO_URL" ]; then
    clone_url="$REPO_URL"
    if [ -n "$GITHUB_TOKEN" ]; then
      clone_url="$(echo "$REPO_URL" | sed -E "s#https://#https://x-access-token:${GITHUB_TOKEN}@#")"
    fi
    if [ -d "$APP_ROOT/.git" ]; then
      git -C "$APP_ROOT" fetch --all --prune
      if [ -n "$BRANCH" ]; then
        git -C "$APP_ROOT" checkout "$BRANCH"
        git -C "$APP_ROOT" pull --ff-only origin "$BRANCH" || git -C "$APP_ROOT" pull --ff-only
      else
        git -C "$APP_ROOT" pull --ff-only
      fi
    else
      rm -rf "$APP_ROOT"
      if [ -n "$BRANCH" ]; then
        git clone --branch "$BRANCH" --depth 1 "$clone_url" "$APP_ROOT"
      else
        git clone --depth 1 "$clone_url" "$APP_ROOT"
      fi
    fi
    return 0
  fi
  if [ -d "$APP_DIR" ]; then
    return 0
  fi
  echo "Provide --repo, --s3, or --dir pointing at an existing app." >&2
  exit 1
}

detect_kind() {
  if [ "$APP_KIND" != "auto" ] && [ -n "$APP_KIND" ]; then
    return 0
  fi
  if [ -f "$APP_DIR/docker-compose.yml" ] || [ -f "$APP_DIR/docker-compose.yaml" ] || [ -f "$APP_DIR/compose.yml" ] || [ -f "$APP_DIR/Dockerfile" ] || [ -f "$APP_DIR/dockerfile" ]; then
    APP_KIND="docker"
  elif { [ -f "$APP_DIR/frontend/package.json" ] || [ -f "$APP_DIR/web/package.json" ] || [ -f "$APP_DIR/client/package.json" ]; } \
    && { [ -f "$APP_DIR/backend/package.json" ] || [ -f "$APP_DIR/server/package.json" ] || [ -f "$APP_DIR/api/package.json" ]; }; then
    APP_KIND="node"
    START_COMMAND="${START_COMMAND:-deplai-node-workspace}"
  elif [ -f "$APP_DIR/package.json" ]; then
    APP_KIND="node"
  elif [ -f "$APP_DIR/requirements.txt" ] || [ -f "$APP_DIR/pyproject.toml" ] || [ -f "$APP_DIR/manage.py" ]; then
    APP_KIND="python"
  elif [ -f "$APP_DIR/go.mod" ]; then
    APP_KIND="go"
  elif [ -f "$APP_DIR/dist/index.html" ] || [ -f "$APP_DIR/build/index.html" ] || [ -f "$APP_DIR/out/index.html" ] || [ -f "$APP_DIR/index.html" ]; then
    APP_KIND="static"
  else
    echo "Could not detect app kind in $APP_DIR. Pass --kind node|python|docker|static|go" >&2
    exit 1
  fi
}

write_env() {
  mkdir -p "$APP_DIR"
  umask 077
  cat > "$APP_DIR/.env" <<ENV
PORT=$APP_PORT
NODE_ENV=production
HOST=0.0.0.0
ENV
  if [ -z "$DATABASE_SECRET_ARN" ]; then
    DATABASE_SECRET_ARN="$(aws rds describe-db-instances --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text 2>/dev/null || true)"
    if [ "$DATABASE_SECRET_ARN" = "None" ]; then
      DATABASE_SECRET_ARN=""
    fi
  fi
  if [ -n "$DATABASE_SECRET_ARN" ]; then
    SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$DATABASE_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)"
    if [ -n "$SECRET_JSON" ] && [ "$SECRET_JSON" != "None" ]; then
      umask 077
      printf '%s' "$SECRET_JSON" > /tmp/deplai-rds-secret.json
      python3 >> "$APP_DIR/.env" <<'PY'
import json, urllib.parse
d = json.load(open("/tmp/deplai-rds-secret.json", encoding="utf-8"))
user = urllib.parse.quote(str(d.get("username") or ""), safe="")
pw = urllib.parse.quote(str(d.get("password") or ""), safe="")
host = str(d.get("host") or "")
port = d.get("port") or 5432
db = str(d.get("dbname") or "appdb")
print(f"DATABASE_URL=postgresql://{user}:{pw}@{host}:{port}/{db}")
print(f"PGHOST={host}")
print(f"PGPORT={port}")
print(f"PGUSER={d.get('username') or ''}")
print(f"PGPASSWORD={d.get('password') or ''}")
print(f"PGDATABASE={db}")
PY
      rm -f /tmp/deplai-rds-secret.json
    fi
  fi
  chown ec2-user:ec2-user "$APP_DIR/.env" 2>/dev/null || true
}

start_nginx_proxy() {
  mkdir -p /etc/nginx/conf.d
  cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 32m;
  location / {
    proxy_pass http://127.0.0.1:${APP_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
NGINX
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

infer_package_port() {
  python3 - "$1" "$2" <<'PY'
import json, re, sys
path, default = sys.argv[1], int(sys.argv[2])
blocked = {5432, 3306, 6379, 27017, 1433, 1521}
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    print(default)
    raise SystemExit(0)
scripts = data.get("scripts") or {}
blob = " ".join(str(v) for v in scripts.values())
match = re.search(r"(?:-p|--port)\s+(\d{2,5})", blob)
if match:
    port = int(match.group(1))
    if 1 <= port <= 65535 and port not in blocked:
        print(port)
        raise SystemExit(0)
print(default)
PY
}

deploy_node_workspace() {
  local web_dir="" api_dir="" rel
  for rel in frontend web client; do
    if [ -f "$APP_DIR/$rel/package.json" ]; then web_dir="$APP_DIR/$rel"; break; fi
  done
  for rel in backend server api; do
    if [ -f "$APP_DIR/$rel/package.json" ]; then api_dir="$APP_DIR/$rel"; break; fi
  done
  [ -n "$web_dir" ] && [ -n "$api_dir" ] || return 1
  dnf install -y nodejs npm
  npm install -g pm2
  ensure_swap
  local web_port api_port
  web_port="$(infer_package_port "$web_dir/package.json" 3000)"
  api_port="$(infer_package_port "$api_dir/package.json" 5000)"
  local saved="$APP_DIR"
  APP_DIR="$api_dir"
  write_env
  APP_DIR="$web_dir"
  write_env
  echo "NEXT_PUBLIC_API_URL=/api" >> "$web_dir/.env"
  APP_DIR="$saved"
  (
    cd "$api_dir"
    if [ -f package-lock.json ]; then npm ci --legacy-peer-deps || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi
    grep -q '"build"' package.json && NODE_OPTIONS="--max-old-space-size=2048" npm run build
    if [ -d prisma ]; then
      set -a; [ -f .env ] && . ./.env; set +a
      npx prisma generate || true
      npx prisma migrate deploy || npx prisma db push || true
    fi
  )
  (
    cd "$web_dir"
    if [ -f package-lock.json ]; then npm ci --legacy-peer-deps || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi
    grep -q '"build"' package.json && NODE_OPTIONS="--max-old-space-size=2048" npm run build
  )
  pm2 delete "${APP_NAME}-api" >/dev/null 2>&1 || true
  pm2 delete "${APP_NAME}-web" >/dev/null 2>&1 || true
  PORT="$api_port" pm2 start npm --name "${APP_NAME}-api" --cwd "$api_dir" -- start
  if [ -x "$web_dir/node_modules/next/dist/bin/next" ]; then
    PORT="$web_port" pm2 start "$web_dir/node_modules/next/dist/bin/next" --name "${APP_NAME}-web" -- start -p "$web_port"
  else
    PORT="$web_port" pm2 start npm --name "${APP_NAME}-web" --cwd "$web_dir" -- start
  fi
  pm2 save
  cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 32m;
  location /api/ {
    proxy_pass http://127.0.0.1:${api_port};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }
  location / {
    proxy_pass http://127.0.0.1:${web_port};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }
}
NGINX
  rm -f /etc/nginx/conf.d/default.conf /usr/share/nginx/html/index.html || true
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

serve_static() {
  local src="$1"
  mkdir -p /usr/share/nginx/html
  rm -rf /usr/share/nginx/html/*
  cp -R "$src"/. /usr/share/nginx/html/
  cat >/etc/nginx/conf.d/deplai-app.conf <<'NGINX'
server {
  listen 80 default_server;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

start_systemd() {
  local cmd="$1"
  cat >/etc/systemd/system/deplai-app.service <<SERVICE
[Unit]
Description=DeplAI app
After=network.target
[Service]
WorkingDirectory=$APP_DIR
Environment=PORT=$APP_PORT
EnvironmentFile=-$APP_DIR/.env
ExecStart=/bin/bash -lc "cd '$APP_DIR' && $cmd"
Restart=always
User=ec2-user
[Install]
WantedBy=multi-user.target
SERVICE
  chown -R ec2-user:ec2-user "$APP_ROOT" || true
  systemctl daemon-reload
  systemctl enable --now deplai-app
}

json_has_script() {
  local name="$1"
  python3 - "$APP_DIR/package.json" "$name" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if name in (data.get("scripts") or {}) else 1)
PY
}

pkg_has_dep() {
  local name="$1"
  python3 - "$APP_DIR/package.json" "$name" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
deps = {}
deps.update(data.get("dependencies") or {})
deps.update(data.get("devDependencies") or {})
raise SystemExit(0 if name in deps else 1)
PY
}

deploy_node() {
  dnf install -y nodejs npm
  npm install -g pm2
  ensure_swap
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
  if [ -f package-lock.json ]; then
    npm ci --legacy-peer-deps || npm install --legacy-peer-deps
  else
    npm install --legacy-peer-deps
  fi
  if [ "$SKIP_BUILD" != "1" ]; then
    if [ -n "$BUILD_COMMAND" ]; then
      bash -lc "$BUILD_COMMAND"
    elif json_has_script build; then
      npm run build
    fi
  fi
  for candidate in dist build out; do
    if [ -f "$APP_DIR/$candidate/index.html" ]; then
      serve_static "$APP_DIR/$candidate"
      return 0
    fi
  done
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  local start="$START_COMMAND"
  if [ -z "$start" ]; then
    if [ -x node_modules/next/dist/bin/next ] || pkg_has_dep next; then
      start="npx next start -p $APP_PORT"
    elif json_has_script start; then
      start="npm run start"
    else
      start="npx serve -s . -l $APP_PORT"
    fi
  fi
  PORT="$APP_PORT" pm2 start bash --name "$APP_NAME" -- -lc "cd '$APP_DIR' && set -a && . ./.env && set +a && PORT='$APP_PORT' $start"
  pm2 save
  env PATH="$PATH" pm2 startup systemd -u root --hp /root >/dev/null || true
  start_nginx_proxy
}

deploy_python() {
  dnf install -y python3 python3-pip python3-devel gcc
  if [ -f requirements.txt ]; then
    python3 -m pip install -r requirements.txt
  elif [ -f pyproject.toml ]; then
    python3 -m pip install .
  fi
  local start="$START_COMMAND"
  if [ -z "$start" ]; then
    if [ -f manage.py ]; then
      start="python3 manage.py runserver 0.0.0.0:$APP_PORT"
    elif [ -f app.py ]; then
      start="python3 -m uvicorn app:app --host 0.0.0.0 --port $APP_PORT"
    elif [ -f main.py ]; then
      start="python3 main.py"
    else
      echo "Pass --start for this Python app." >&2
      exit 1
    fi
  fi
  if [ -n "$BUILD_COMMAND" ]; then
    bash -lc "$BUILD_COMMAND"
  fi
  start_systemd "$start"
  start_nginx_proxy
}

deploy_docker() {
  dnf install -y docker
  systemctl enable --now docker
  mkdir -p /usr/local/lib/docker/cli-plugins
  if [ ! -x /usr/local/lib/docker/cli-plugins/docker-compose ]; then
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ]; then
    docker compose up -d --build
    return 0
  fi
  docker build -t "$APP_NAME:latest" .
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$APP_NAME" --restart unless-stopped \
    --env-file "$APP_DIR/.env" -e PORT="$APP_PORT" \
    -p "127.0.0.1:$APP_PORT:$APP_PORT" "$APP_NAME:latest"
  start_nginx_proxy
}

deploy_go() {
  dnf install -y golang
  local bin="$APP_DIR/bin/app"
  mkdir -p "$APP_DIR/bin"
  (cd "$APP_DIR" && go build -o "$bin" .)
  start_systemd "$bin"
  start_nginx_proxy
}

deploy_static() {
  local src="$APP_DIR"
  for candidate in dist build out .; do
    if [ -f "$APP_DIR/$candidate/index.html" ]; then
      src="$APP_DIR/$candidate"
      break
    fi
  done
  serve_static "$src"
}

ensure_pkgs
clone_or_unpack
if [ ! -d "$APP_DIR" ]; then
  echo "App directory missing: $APP_DIR" >&2
  exit 1
fi
detect_kind
write_env
chown -R ec2-user:ec2-user "$APP_ROOT" || true
cd "$APP_DIR"
echo "Deploying kind=$APP_KIND dir=$APP_DIR port=$APP_PORT"

case "$APP_KIND" in
  node)
    if deploy_node_workspace; then
      :
    else
      deploy_node
    fi
    ;;
  python) deploy_python ;;
  docker) deploy_docker ;;
  go) deploy_go ;;
  static) deploy_static ;;
  *) echo "Unsupported --kind $APP_KIND" >&2; exit 1 ;;
esac

IMDS_TOKEN="$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
PUBLIC_IP="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
echo "Done. App should be on http://${PUBLIC_IP:-EIP}:80"
echo "Logs: $LOG"
if [ "$APP_KIND" = "node" ]; then
  echo "Process: pm2 status"
elif [ "$APP_KIND" = "docker" ]; then
  echo "Process: docker ps"
else
  echo "Process: systemctl status deplai-app"
fi
