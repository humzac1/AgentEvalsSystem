"""
SandboxExecutor — in-memory tool execution sandbox for agent simulations.

Each executor instance holds a fresh in-memory store (dict of
collection_name → list[dict]) seeded with the agent's tool_seed_data.
Operations are stateful within a session and reset between sessions.

Supported operation types:
  CREATE   — insert a new record into a collection
  READ     — retrieve one record by id
  UPDATE   — patch fields on an existing record
  DELETE   — remove a record by id
  LIST     — return all records in a collection (optional filter)
  SEND     — "send" a message/notification (creates a log record)
  CALCULATE — perform a simple numeric calculation
"""

from __future__ import annotations

import copy
import json
import sys
import os
import uuid
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from observability import langfuse

# Prefix map for ID generation: collection_name substring → prefix
_ID_PREFIX_MAP = {
    "invoice": "INV",
    "customer": "CUST",
    "email": "MSG",
    "message": "MSG",
    "order": "ORD",
    "ticket": "TKT",
    "product": "PRD",
    "employee": "EMP",
    "leave": "LVE",
    "payroll": "PAY",
}


def _make_id(collection_name: str, store_len: int) -> str:
    col_lower = collection_name.lower()
    prefix = next(
        (v for k, v in _ID_PREFIX_MAP.items() if k in col_lower), "REC"
    )
    return f"{prefix}-{(store_len + 1):04d}"


class SandboxExecutor:
    """
    Stateful in-memory executor for sandboxed tool calls.

    Args:
        tools: List of tool dicts (as returned by get_all_tools()).
        seed_data: List of seed data dicts (as returned by get_all_seed_data()).
    """

    def __init__(self, tools: list[dict], seed_data: list[dict]) -> None:
        # Registry of tools keyed by name
        self._tools: dict[str, dict] = {t["name"]: t for t in tools}

        # In-memory store: collection_name → list of records
        self._store: dict[str, list[dict]] = {}

        # Seed the store
        for s in seed_data:
            col = s["collection_name"]
            records = copy.deepcopy(s.get("records", []))
            if not records:
                continue
            if col not in self._store:
                self._store[col] = []

            # _read() looks up by rec.get("id"), but seed records commonly use
            # collection-specific keys (customer_id, invoice_id, etc.) with no
            # generic "id" field.  Promote the collection-specific key to "id"
            # so all lookup paths work uniformly.  Mirror the col[:-1]_id
            # pattern already used by _read() for input resolution.
            col_id_key = f"{col[:-1]}_id"
            existing_ids = {
                str(r["id"]) for r in self._store[col] if r.get("id") is not None
            }

            for record in records:
                if "id" not in record and col_id_key in record:
                    record["id"] = record[col_id_key]
                # Deduplicate: multiple tools can seed the same collection with
                # overlapping records; merge by id rather than blindly extending.
                rec_id = record.get("id")
                if rec_id is not None and str(rec_id) in existing_ids:
                    continue
                if rec_id is not None:
                    existing_ids.add(str(rec_id))
                self._store[col].append(record)

        store_counts = {col: len(recs) for col, recs in self._store.items()}
        print(
            f"[SandboxExecutor] Initialized store with collections: "
            f"{list(self._store.keys())} — record counts: {store_counts}"
        )

        # Call log for this session
        self._call_log: list[dict] = []

    # ── Public interface ───────────────────────────────────────────────────────

    def execute(self, tool_name: str, inputs: dict[str, Any]) -> dict[str, Any]:
        """
        Execute a named tool with the given inputs.
        Returns {"success": bool, "result": ..., "error": str|None}.
        """
        tool = self._tools.get(tool_name)
        if not tool:
            return self._error(f"Unknown tool: {tool_name}")

        inputs = self._coerce_inputs(inputs, tool)

        op = tool["operation_type"].upper()
        col = tool["collection_name"]

        try:
            with langfuse.start_as_current_observation(
                name=f"tool-call-{tool_name}",
                as_type="span",
                input={"tool": tool_name, "inputs": inputs},
            ) as _span:
                if op == "CREATE":
                    result = self._create(col, inputs)
                elif op == "READ":
                    result = self._read(col, inputs)
                elif op == "UPDATE":
                    result = self._update(col, inputs)
                elif op == "DELETE":
                    result = self._delete(col, inputs)
                elif op == "LIST":
                    result = self._list(col, inputs)
                elif op == "SEND":
                    result = self._send(col, inputs)
                elif op == "CALCULATE":
                    result = self._calculate(inputs)
                else:
                    _span.update(output={"success": False, "error": f"Unknown operation: {op}"})
                    return self._error(f"Unknown operation type: {op}")
                _span.update(output={"result": result, "success": True, "error": None})
        except Exception as exc:
            return self._error(str(exc))

        entry = {"tool": tool_name, "inputs": inputs, "result": result, "success": True}
        self._call_log.append(entry)
        return {"success": True, "result": result, "error": None}

    @property
    def call_log(self) -> list[dict]:
        return list(self._call_log)

    def get_store_snapshot(self) -> dict[str, list[dict]]:
        """Return a deep copy of the current in-memory store (for evaluation)."""
        return copy.deepcopy(self._store)

    # ── Operation handlers ─────────────────────────────────────────────────────

    def _create(self, col: str, inputs: dict) -> dict:
        if col not in self._store:
            self._store[col] = []
        record = dict(inputs)
        # Assign an ID if not provided
        if "id" not in record:
            record["id"] = _make_id(col, len(self._store[col]))
        self._store[col].append(record)
        return record

    def _read(self, col: str, inputs: dict) -> dict | None:
        record_id = inputs.get("id") or inputs.get(f"{col[:-1]}_id") or inputs.get("record_id")
        if not record_id:
            raise ValueError("READ requires an 'id' field in inputs")
        for rec in self._store.get(col, []):
            if str(rec.get("id")) == str(record_id):
                return rec
        return None  # not found — agent should handle gracefully

    def _update(self, col: str, inputs: dict) -> dict:
        record_id = inputs.get("id") or inputs.get(f"{col[:-1]}_id") or inputs.get("record_id")
        if not record_id:
            raise ValueError("UPDATE requires an 'id' field in inputs")
        for rec in self._store.get(col, []):
            if str(rec.get("id")) == str(record_id):
                for k, v in inputs.items():
                    if k not in ("id",):
                        rec[k] = v
                return rec
        raise ValueError(f"Record '{record_id}' not found in '{col}'")

    def _delete(self, col: str, inputs: dict) -> dict:
        record_id = inputs.get("id") or inputs.get(f"{col[:-1]}_id") or inputs.get("record_id")
        if not record_id:
            raise ValueError("DELETE requires an 'id' field in inputs")
        collection = self._store.get(col, [])
        for i, rec in enumerate(collection):
            if str(rec.get("id")) == str(record_id):
                removed = collection.pop(i)
                return {"deleted": True, "record": removed}
        raise ValueError(f"Record '{record_id}' not found in '{col}'")

    def _list(self, col: str, inputs: dict) -> list[dict]:
        records = self._store.get(col, [])
        # Optional simple filter: any key/value pair in inputs that isn't pagination
        skip_keys = {"limit", "offset", "page", "page_size"}
        filters = {k: v for k, v in inputs.items() if k not in skip_keys}
        if filters:
            records = [
                r for r in records
                if all(str(r.get(k)) == str(v) for k, v in filters.items())
            ]
        limit = inputs.get("limit")
        if limit is not None:
            try:
                records = records[: int(limit)]
            except (ValueError, TypeError):
                pass
        return records

    def _send(self, col: str, inputs: dict) -> dict:
        """Log a 'sent' record (email, notification, etc.)."""
        if col not in self._store:
            self._store[col] = []
        record = {
            "id": _make_id(col, len(self._store[col])),
            "status": "sent",
            **inputs,
        }
        self._store[col].append(record)
        return {"sent": True, "record": record}

    def _calculate(self, inputs: dict) -> dict:
        if "line_items" in inputs:
            return self._calculate_invoice(inputs)

        # Simple arithmetic path
        op = str(inputs.get("operation", "add")).lower()
        try:
            a = float(inputs.get("a", 0))
            b = float(inputs.get("b", 0))
        except (ValueError, TypeError) as exc:
            raise ValueError(f"Invalid numeric inputs: {exc}") from exc

        if op in ("add", "sum", "+"):
            result = a + b
        elif op in ("subtract", "minus", "-"):
            result = a - b
        elif op in ("multiply", "times", "*", "x"):
            result = a * b
        elif op in ("divide", "/"):
            if b == 0:
                raise ValueError("Division by zero")
            result = a / b
        else:
            raise ValueError(f"Unknown operation: {op}")

        return {"result": result, "operation": op, "a": a, "b": b}

    def _calculate_invoice(self, inputs: dict) -> dict:
        line_items = inputs.get("line_items", [])
        if isinstance(line_items, str):
            try:
                line_items = json.loads(line_items)
            except (json.JSONDecodeError, ValueError):
                line_items = []
        if not isinstance(line_items, list):
            line_items = []

        subtotal = sum(
            float(item.get("hours", 0)) * float(item.get("rate", 0))
            for item in line_items
        )

        rush = inputs.get("rush", False)
        if isinstance(rush, str):
            rush = rush.lower() in ("true", "1", "yes")
        rush_surcharge = round(subtotal * 0.25, 2) if rush else 0.0

        discount_type = str(inputs.get("discount_type", "none")).lower().strip()
        discount_pct = 0.0
        if discount_type == "retainer":
            discount_pct = 8.0
        elif discount_type == "new_client":
            discount_pct = 5.0
        elif discount_type == "volume" and subtotal > 50000:
            discount_pct = 10.0

        discount_amount = round(subtotal * (discount_pct / 100), 2)
        total = round(subtotal + rush_surcharge - discount_amount, 2)

        return {
            "subtotal": round(subtotal, 2),
            "rush_surcharge": rush_surcharge,
            "discount_percentage": discount_pct,
            "discount_amount": discount_amount,
            "total": total,
        }

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _coerce_inputs(self, inputs: dict, tool_def: dict) -> dict:
        """Parse string values to array/object when the schema declares them as such."""
        props = tool_def.get("input_schema", {})
        if isinstance(props, dict):
            props = props.get("properties", {})
        if not isinstance(props, dict):
            return inputs
        coerced = {}
        for key, value in inputs.items():
            field_def = props.get(key, {})
            expected_type = field_def.get("type", "string") if isinstance(field_def, dict) else "string"
            if expected_type in ("array", "object") and isinstance(value, str):
                try:
                    value = json.loads(value)
                except (json.JSONDecodeError, ValueError):
                    pass
            coerced[key] = value
        return coerced

    @staticmethod
    def _error(message: str) -> dict:
        return {"success": False, "result": None, "error": message}

    def build_tools_for_anthropic(self) -> list[dict]:
        """
        Convert sandbox tools to Anthropic API tool definitions.
        Returns a list of tool dicts ready for the `tools` parameter.
        """
        api_tools = []
        for tool in self._tools.values():
            input_schema = tool.get("input_schema", {})
            if not isinstance(input_schema, dict):
                input_schema = {}
            # Ensure required fields for Anthropic tool schema
            schema = {
                "type": "object",
                "properties": input_schema.get("properties", {}),
            }
            if "required" in input_schema:
                schema["required"] = input_schema["required"]
            api_tools.append({
                "name": tool["name"],
                "description": tool["description"],
                "input_schema": schema,
            })
        return api_tools

    def format_tools_for_prompt(self) -> str:
        """
        Return a human-readable TOOLS AVAILABLE section for the system prompt.
        """
        if not self._tools:
            return ""
        lines = ["\n\n## TOOLS AVAILABLE\n"]
        lines.append(
            "You have access to the following tools. Call them by responding with a "
            "tool_use block. Results will be returned as tool_result blocks.\n"
        )
        for tool in self._tools.values():
            lines.append(f"### {tool['display_name']} (`{tool['name']}`)")
            lines.append(f"{tool['description']}\n")
            schema = tool.get("input_schema", {})
            props = schema.get("properties", {}) if isinstance(schema, dict) else {}
            if props:
                lines.append("**Parameters:**")
                required = schema.get("required", []) if isinstance(schema, dict) else []
                for param, info in props.items():
                    req_marker = " *(required)*" if param in required else ""
                    desc = info.get("description", "") if isinstance(info, dict) else ""
                    ptype = info.get("type", "string") if isinstance(info, dict) else "string"
                    lines.append(f"- `{param}` ({ptype}){req_marker}: {desc}")
            lines.append("")
        return "\n".join(lines)
