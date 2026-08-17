import json

def _overlay_field(data, key, stored_value):
    original_value = data.get(key)
    if stored_value is not None and stored_value != "":
        if isinstance(original_value, dict) and isinstance(stored_value, str):
            try:
                parsed = json.loads(stored_value)
                if isinstance(parsed, dict):
                    data[key] = parsed
                else:
                    data[key] = original_value
            except (json.JSONDecodeError, TypeError):
                data[key] = original_value
        else:
            data[key] = stored_value
    elif original_value is not None:
        data[key] = original_value
    else:
        data[key] = ""

# Case 1: stringified Python dict (single quotes) -> should preserve original
data = {"creator": {"name": "Test", "notes": "Note"}}
_overlay_field(data, "creator", "{'name': 'Test', 'notes': 'Note'}")
assert data["creator"] == {"name": "Test", "notes": "Note"}, f"Case 1 failed: {data['creator']}"
print("Case 1 (stringified dict):", data["creator"])

# Case 2: empty string -> should preserve original
data = {"creator": {"name": "Test", "notes": "Note"}}
_overlay_field(data, "creator", "")
assert data["creator"] == {"name": "Test", "notes": "Note"}, f"Case 2 failed: {data['creator']}"
print("Case 2 (empty string):", data["creator"])

# Case 3: plain string -> should preserve original
data = {"creator": {"name": "Test", "notes": "Note"}}
_overlay_field(data, "creator", "plain string")
assert data["creator"] == {"name": "Test", "notes": "Note"}, f"Case 3 failed: {data['creator']}"
print("Case 3 (plain string):", data["creator"])

# Case 4: valid JSON dict string -> should use parsed
data = {"creator": {"name": "Test", "notes": "Note"}}
_overlay_field(data, "creator", '{"name": "New"}')
assert data["creator"] == {"name": "New"}, f"Case 4 failed: {data['creator']}"
print("Case 4 (JSON string dict):", data["creator"])

# Case 5: None stored -> should preserve original
data = {"creator": {"name": "Test", "notes": "Note"}}
_overlay_field(data, "creator", None)
assert data["creator"] == {"name": "Test", "notes": "Note"}, f"Case 5 failed: {data['creator']}"
print("Case 5 (None):", data["creator"])

print("All overlay tests passed")
