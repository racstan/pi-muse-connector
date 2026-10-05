#!/bin/bash
# Replicates the exact Pi setup recipe from the dev VM:
#   1. Pi installed via npm (done in Dockerfile, version pinned)
#   2. Provider config in ~/.pi/agent/models.json (generated here from env)
#   3. API key from environment (on the dev VM this is a vault surrogate;
#      in production it is a real key with a spend cap)
set -e

KEY_ENV="${PI_KEY_ENV:-OPENROUTER_API_KEY}"
KEY_VALUE="${!KEY_ENV:-}"
PROVIDER="${PI_PROVIDER:-openrouter}"
MODEL="${PI_MODEL:-openrouter/free}"

case "$PROVIDER" in
  openrouter) BASE_URL="https://openrouter.ai/api/v1" ;;
  nvidia)     BASE_URL="https://integrate.api.nvidia.com/v1" ;;
  *)          BASE_URL="${PI_BASE_URL:-}" ;;
esac

if [ -z "$KEY_VALUE" ]; then
  echo "WARN: $KEY_ENV is not set — Pi tasks will fail unless the provider needs no key."
fi
if [ -z "$BASE_URL" ]; then
  echo "WARN: no base URL for provider '$PROVIDER' — set PI_BASE_URL."
fi

mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "$PROVIDER": {
      "api": "openai-completions",
      "apiKey": "$KEY_VALUE",
      "baseUrl": "$BASE_URL",
      "models": [{ "id": "$MODEL" }]
    }
  }
}
EOF
chmod 600 "$HOME/.pi/agent/models.json"

exec node server/index.js
