# Architecture JSON Contracts

This file defines the shared payload contract used by:

1. Architecture JSON Generator
2. Cost Estimator
3. Diagram Generator
4. Terraform Generator

## 1. Canonical Architecture JSON

```json
{
  "title": "Production Web App",
  "provider": "aws",
  "schema_version": "1.0",
  "metadata": {
    "source": "deterministic_template"
  },
  "nodes": [
    {
      "id": "webAppServer",
      "type": "AmazonEC2",
      "label": "Web Server",
      "region": "Asia Pacific (Mumbai)",
      "attributes": {
        "instanceType": "t3.micro",
        "instanceCount": 1
      }
    },
    {
      "id": "websiteBucket",
      "type": "AmazonS3",
      "label": "Website Bucket",
      "region": "Asia Pacific (Mumbai)",
      "attributes": {
        "storageGB": 10,
        "storageClass": "Standard"
      }
    }
  ],
  "edges": [
    {
      "from": "webAppServer",
      "to": "websiteBucket",
      "label": "writes static content"
    }
  ]
}
```

## 2. Validation Rules

1. `title` is required and non-empty.
2. `provider` is optional, but when present must be one of `aws`, `azure`, `gcp`.
3. `schema_version` defaults to `1.0`.
4. `nodes` is required and must contain at least one item.
5. Each node requires:
   - `id` matching `^[A-Za-z][A-Za-z0-9_-]{0,127}$`
   - `type` non-empty string
   - `attributes` object (defaults to `{}` if missing)
6. Node ids must be unique.
7. `edges` defaults to `[]` when omitted.
8. Each edge requires `from` and `to`, and both must reference existing node ids.
9. `metadata` defaults to `{}` when omitted.

## 3. Stage I/O Contracts

1. Architecture Generator output:
   - Emits canonical architecture JSON.
   - Contract validation is enforced before API success response.
2. Cost Estimator input:
   - Accepts only canonical architecture JSON.
   - Rejects invalid graph payloads with clear validation errors.
3. Diagram Generator input:
   - Accepts only canonical architecture JSON.
   - Produces Mermaid output and node icon preview metadata.
4. Terraform Generator input:
   - Accepts only canonical architecture JSON.
   - Uses validated payload for RAG-based Terraform generation.

## 4. Failure Behavior

If contract validation fails at any stage, the API returns `400` (client input issue) with a message:

`architecture_json contract validation failed: ...`

For model-generated architecture outputs that fail contract checks, generation returns a failure response with validation details.
