"""
Shared architecture JSON contract used across generation, cost, diagram, and IaC.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

CloudProvider = Literal["aws", "azure", "gcp"]
_NODE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")


class ArchitectureContractError(ValueError):
    """Raised when architecture JSON does not match the shared contract."""


class ArchitectureNode(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: str
    type: str
    label: str | None = None
    region: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id")
    @classmethod
    def node_id_valid(cls, value: str) -> str:
        if not _NODE_ID_RE.match(value):
            raise ValueError(
                "node id must start with a letter and contain only letters, digits, '_' or '-' (max 128 chars)"
            )
        return value

    @field_validator("type")
    @classmethod
    def node_type_non_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("node type must not be empty")
        return value


class ArchitectureEdge(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True, str_strip_whitespace=True)

    from_node: str = Field(alias="from")
    to_node: str = Field(alias="to")
    label: str | None = None

    @field_validator("from_node", "to_node")
    @classmethod
    def edge_endpoint_non_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("edge endpoint must not be empty")
        return value


class ArchitectureDocument(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True, str_strip_whitespace=True)

    title: str
    provider: CloudProvider | None = None
    schema_version: str = "1.0"
    nodes: list[ArchitectureNode]
    edges: list[ArchitectureEdge] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("title")
    @classmethod
    def title_non_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("title must not be empty")
        return value

    @field_validator("schema_version")
    @classmethod
    def schema_version_non_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("schema_version must not be empty")
        return value

    @field_validator("nodes")
    @classmethod
    def nodes_non_empty(cls, value: list[ArchitectureNode]) -> list[ArchitectureNode]:
        if not value:
            raise ValueError("nodes must contain at least one node")
        return value

    @model_validator(mode="after")
    def graph_integrity(self) -> "ArchitectureDocument":
        node_ids = [node.id for node in self.nodes]
        seen: set[str] = set()
        duplicates: set[str] = set()
        for node_id in node_ids:
            if node_id in seen:
                duplicates.add(node_id)
                continue
            seen.add(node_id)
        duplicate_list = sorted(duplicates)
        if duplicate_list:
            raise ValueError(f"duplicate node ids found: {', '.join(duplicate_list)}")

        valid_ids = set(node_ids)
        dangling: list[str] = []
        for edge in self.edges:
            if edge.from_node not in valid_ids or edge.to_node not in valid_ids:
                dangling.append(f"{edge.from_node}->{edge.to_node}")
        if dangling:
            raise ValueError(
                f"edges reference unknown nodes: {', '.join(dangling)}"
            )
        return self

    def to_wire_dict(self) -> dict[str, Any]:
        """Return normalized payload preserving edge aliases ('from'/'to')."""
        return self.model_dump(by_alias=True, exclude_none=True)


def parse_architecture_document(payload: Any) -> ArchitectureDocument:
    """Validate and parse raw payload to the shared architecture contract."""
    try:
        return ArchitectureDocument.model_validate(payload)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in err.get('loc', []))}: {err.get('msg')}"
            for err in exc.errors()
        )
        raise ArchitectureContractError(details or "Invalid architecture_json payload") from exc


def normalize_architecture_json(payload: Any) -> dict[str, Any]:
    """Validate and return normalized architecture JSON."""
    return parse_architecture_document(payload).to_wire_dict()
