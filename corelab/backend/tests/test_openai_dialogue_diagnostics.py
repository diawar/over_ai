import pytest
from fastapi import HTTPException
from app.dialogue_views import _decode_openai

@pytest.mark.parametrize('status,reason,tokens,expected', [
    ('incomplete', 'max_output_tokens', 2400, 'reason=max_output_tokens output_tokens=2400'),
    ('private status', 'private reason', 'private usage', 'reason=unknown output_tokens=None'),
])
def test_incomplete_diagnostics_are_allowlisted(caplog, status, reason, tokens, expected):
    with pytest.raises(HTTPException) as error:
        _decode_openai({'status':status, 'incomplete_details':{'reason':reason},
                        'usage':{'output_tokens':tokens}, 'output':'private output'})
    assert error.value.status_code == 502
    assert expected in caplog.text
    assert 'private' not in caplog.text
