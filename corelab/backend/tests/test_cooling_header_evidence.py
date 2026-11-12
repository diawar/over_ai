import pytest
from fastapi import HTTPException
from app.cooling_inventory import merge_header_evidence

def test_header_enrichment_preserves_verified_counts():
    old = [{'kind': 'system_fan_header', 'count': 2, 'raw': '2 x SYS_FAN'}]
    new = ['1 x CPU_FAN 4-pin PWM 1 A', '2 x SYS_FAN 4-pin PWM 1 A']
    result = merge_header_evidence(old, new)
    assert sum(row['count'] for row in result) == 3
    with pytest.raises(HTTPException, match='противоречит'):
        merge_header_evidence(old, ['1 x CPU_FAN 4-pin PWM 1 A', '1 x SYS_FAN 4-pin PWM 1 A'])

def test_shorter_board_spec_does_not_duplicate_existing_combo_headers():
    old = ['1 x CPU_FAN/PUMP 4-pin PWM DC 2 A', '1 x SYS_FAN1/PUMP 4-pin PWM DC 2 A']
    result = merge_header_evidence(old, ['1 x CPU_FAN', '1 x SYS_FAN'])
    assert sum(row['count'] for row in result) == 2
    assert merge_header_evidence(result, result) == result
