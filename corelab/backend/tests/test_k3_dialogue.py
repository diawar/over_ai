import json
from types import SimpleNamespace
import pytest
from app import dialogue_views as views


@pytest.mark.parametrize("mode,effort,tokens,timeout", [
    ("dialogue", "low", 4096, 90),
    ("explanation", "low", 8192, 90),
    ("planner", "high", 8192, 180),
])
def test_k3_uses_its_own_contract_and_still_validates(monkeypatch, mode, effort, tokens, timeout):
    schema = {"type": "object", "properties": {"action": {"type": "string"}},
              "required": ["action"], "additionalProperties": False}
    seen = []
    monkeypatch.setattr(views, "decrypt_key", lambda _: "test-key")
    def request(key, path, payload, **kwargs):
        seen.append(payload)
        assert key == "test-key"
        assert path == "/chat/completions"
        assert payload["reasoning_effort"] == effort
        assert payload["max_completion_tokens"] == tokens
        assert "max_tokens" not in payload and "thinking" not in payload
        assert payload["response_format"]["json_schema"] == {
            "name": "corelab_dialogue", "strict": True, "schema": schema}
        assert kwargs["timeout_seconds"] == timeout
        return {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"action": "ok"}), "reasoning_content": "private reasoning"}}]}
    monkeypatch.setattr(views, "kimi_request", request)
    row = SimpleNamespace(provider="kimi", model_id="kimi-k3", encrypted_api_key="unused")
    assert views._dialogue(row, "Return JSON", [{"role": "user", "content": "test"}], schema, mode) == {"action": "ok"}
    assert len(seen) == 1
