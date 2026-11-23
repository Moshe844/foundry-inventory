#!/usr/bin/env bash
# CI-only: pin the official validator and managed rules without installing
# another tool on the operator's computer or provisioning AWS resources.
set -euo pipefail

scratch="${RUNNER_TEMP:?Run this validator on the disposable CI runner}/stockchief-cfn-guard"
output="output/aws-import-security"
mkdir -p "$scratch/bin" "$scratch/rules" "$output"
archive="$scratch/guard.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  'https://github.com/aws-cloudformation/cloudformation-guard/releases/download/3.3.0/cfn-guard-v3-ubuntu-latest.tar.gz' -o "$archive"
printf '%s  %s\n' '3c2c9b8e8041cbb950a5b4479efed7f79cf167d4d4ad22c3e23862f04789248b' "$archive" | sha256sum --check -
tar -xzf "$archive" -C "$scratch/bin"
if command -v rg >/dev/null 2>&1; then
  mapfile -t binaries < <(rg --files --hidden --no-ignore "$scratch/bin" | rg '/cfn-guard$')
else
  mapfile -t binaries < <(find "$scratch/bin" -type f -name cfn-guard)
fi
if [[ ${#binaries[@]} -ne 1 ]]; then echo 'Expected one verified Guard executable.' >&2; exit 1; fi
guard="${binaries[0]}"
"$guard" --version

registry='7f7340c26ae5d5e8874651dbffeb12e0e9f505b6'
for rule in s3_bucket_level_public_access_prohibited s3_bucket_server_side_encryption_enabled s3_bucket_versioning_enabled; do
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/aws-cloudformation/aws-guard-rules-registry/$registry/rules/aws/amazon_s3/$rule.guard" \
    -o "$scratch/rules/$rule.guard"
done
"$guard" validate --rules "$scratch/rules" --data infra/aws-imports/template.json --output-format json > "$output/guard.json"
cat "$output/guard.json"
