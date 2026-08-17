import sys
sys.path.insert(0, "/app")
from app.services.unified_model_registry import get_flat_model_list
flat = get_flat_model_list()
print("FLAT MODEL COUNT:", len(flat))
m = next((x for x in flat if "deepseek-v4-flash" in (x.get("id") or "")), None)
if m:
    print("MODEL:", m["id"])
    print("  provider:", m.get("provider"), "| provider_count:", m.get("provider_count"))
    print("  providers:", [(p.get("provider_name"), p.get("provider_id")) for p in m.get("providers", [])])
else:
    print("deepseek-v4-flash not found in flat list")
