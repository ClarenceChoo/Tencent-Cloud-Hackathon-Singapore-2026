"""OpenAI function definitions for the existing, confirmed care workflow."""
from copy import deepcopy
import json

from pydantic import ValidationError

from .providers import ProviderResponseError, parse_interpretation
from .services import PAYLOAD_MODELS


CARE_TOOLS = {
    "propose_health_note": ("health_note", "Propose a general reported health observation, private unless the speaker explicitly asks to share it. Stated external blood-pressure readings use record_measurement; dose reports use report_medication."),
    "report_medication": ("medication_report", "Propose the speaker's reported status for one identified dose in the active checked plan."),
    "record_measurement": ("measurement", "Use for a reported external blood-pressure reading with systolic and diastolic values, stated time and measurement source. Ask for missing facts instead of storing the reading as a general note; never invent a reading."),
    "update_preventive_task": ("preventive_task", "Propose a reported transition of an existing preventive task, or a task from an explicitly stated care plan."),
    "request_support": ("support_request", "Propose sharing a support request with one explicitly identified permitted recipient; this does not dispatch help."),
    "update_followup": ("followup", "Propose a follow-up with a stated time and sharing choice, or resolve one with a human-reported outcome."),
}


def _strict(schema):
    schema = deepcopy(schema)
    schema.pop("title", None)
    schema.pop("default", None)
    if schema.get("type") == "object":
        properties = schema.get("properties", {})
        formerly_required = set(schema.get("required", []))
        for key, value in list(properties.items()):
            value = _strict(value)
            if key not in formerly_required and value.get("type") != "null" and not any(
                option.get("type") == "null" for option in value.get("anyOf", [])
            ):
                value = {"anyOf": [value, {"type": "null"}]}
            properties[key] = value
        schema["properties"] = properties
        schema["required"] = list(properties)
        schema["additionalProperties"] = False
    if "items" in schema:
        schema["items"] = _strict(schema["items"])
    for key in ("anyOf", "oneOf", "allOf"):
        if key in schema:
            schema[key] = [_strict(value) for value in schema[key]]
    if "$defs" in schema:
        schema["$defs"] = {key: _strict(value) for key, value in schema["$defs"].items()}
    return schema


def _function(name, description, properties):
    return {"type": "function", "name": name, "description": description,
            "parameters": {"type": "object", "properties": properties,
                           "required": list(properties), "additionalProperties": False}, "strict": True}


def function_tools():
    tools = []
    for name, (kind, description) in CARE_TOOLS.items():
        model = PAYLOAD_MODELS[kind]
        schema = model.model_json_schema()
        for field in list(schema["properties"]):
            if model.model_fields[field].exclude or field == "plan_version":
                schema["properties"].pop(field)
                if field in schema.get("required", []):
                    schema["required"].remove(field)
        tools.append(_function(name, description + " Every change needs a separate review and explicit confirmation.", {
            "operation": {"type": "string", "enum": ["propose", "correct"],
                          "description": "Use correct only when revising the identified current proposal."},
            "payload": _strict(schema),
        }))
    tools.append(_function("confirm_current_update", "Request confirmation of the identified current read-back. The server independently checks explicit confirmation words and current permissions.", {}))
    tools.append(_function("get_medication_explanation", "Read reviewed instructions and source text for one medicine in the active checked plan. Never provide new medical advice.", {"medicine_id": {"type": "string"}}))
    for name, description in [("get_support_status", "Read the recorded acknowledgement or resolution of an identified support request."),
                              ("get_followup_status", "Read the recorded outcome of an identified follow-up.")]:
        tools.append(_function(name, description, {"record_id": {"type": "string"}}))
    tools.append(_function("respond_to_user", "Ask one clarification question or offer brief nonclinical conversation. Never claim a record was saved, shared or acknowledged.", {
        "intent": {"type": "string", "enum": ["clarify", "chat"]},
        "spoken_text": {"type": "string", "minLength": 1, "maxLength": 600},
    }))
    return tools


def interpret_function_call(name, arguments):
    """Validate a model call before the worker rechecks and executes its effect."""
    try:
        if not isinstance(arguments, str) or len(arguments) > 16000:
            raise ValueError()
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        value = json.loads(arguments, object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError()
        result = {"intent": "", "kind": None, "payload": {}, "spoken_text": ""}
        if name in CARE_TOOLS:
            if set(value) != {"operation", "payload"} or value["operation"] not in {"propose", "correct"} or not isinstance(value["payload"], dict):
                raise ValueError()
            kind = CARE_TOOLS[name][0]
            payload = {key: item for key, item in value["payload"].items() if item is not None}
            model = PAYLOAD_MODELS[kind]
            allowed = {key for key, field in model.model_fields.items() if not field.exclude and key != "plan_version"}
            if set(value["payload"]) - allowed:
                raise ValueError()
            payload = model.model_validate(payload).model_dump(mode="json", exclude_none=True)
            result.update(intent="correct" if value["operation"] == "correct" else "proposal", kind=kind, payload=payload)
        elif name == "confirm_current_update" and not value:
            result["intent"] = "confirm"
        elif name == "get_medication_explanation" and set(value) == {"medicine_id"} and isinstance(value["medicine_id"], str) and value["medicine_id"].strip():
            result.update(intent="explain", payload=value)
        elif name in {"get_support_status", "get_followup_status"} and set(value) == {"record_id"} and isinstance(value["record_id"], str) and value["record_id"].strip():
            result.update(intent="support_status" if name == "get_support_status" else "followup_status", payload=value)
        elif name == "respond_to_user" and set(value) == {"intent", "spoken_text"} and value["intent"] in {"clarify", "chat"} and isinstance(value["spoken_text"], str) and 0 < len(value["spoken_text"].strip()) <= 600:
            result.update(value)
        else:
            raise ValueError()
        return parse_interpretation(json.dumps(result))
    except (ValueError, TypeError, KeyError, ValidationError) as exc:
        raise ProviderResponseError("The language provider returned an invalid care tool call.") from exc
