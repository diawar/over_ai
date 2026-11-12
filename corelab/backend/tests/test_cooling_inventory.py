import pytest
from app.cooling_inventory import normalize_cooling_inventory as norm
from app.property_engine import RuleDefinition, normalize


def test_addressable_gen2_is_standard_argb_not_12v_rgb():
    gen2 = norm('motherboard_lighting_headers', ['1 x Addressable RGB Gen2 5V 3-pin'])
    argb = norm('cooling_lighting_connectors', ['1 x ARGB 5V 3-pin'])
    rgb = norm('motherboard_lighting_headers', ['1 x RGB 12V 4-pin'])
    assert gen2[0]['kind'] == argb[0]['kind'] == 'argb_3pin_5v'
    assert rgb[0]['kind'] == 'rgb_4pin_12v'


@pytest.mark.parametrize('code,value', [
    ('cooler_fan_connectors', ['1 x 4-pin PWM 0.2 A', '4 pin pwm 0.2 A']),
    ('cooling_lighting_connectors', ['1 x 3-pin 5V ARGB', '3 pin 5v argb']),
    ('cooling_lighting_connectors', ['none']),
    ('motherboard_fan_headers', ['1 x CPU_FAN 4-pin PWM 2 A', '2 x SYS_FAN/PUMP 4-pin PWM DC 2 A']),
])
def test_canonical_and_idempotent(code, value):
    normalized = norm(code, value)
    assert norm(code, normalized) == normalized
    if code != 'motherboard_fan_headers':
        assert len(normalized) == 1
    # The shared property engine covers manual and bulk editing, not just AI loads.
    rule = RuleDefinition(code=code, label=code, level='required', value_type='list')
    assert normalize(value, rule) == normalized


def test_combo_header_is_one_inventory_group():
    rows = norm('motherboard_fan_headers', ['1 x SYS_FAN/PUMP 4-pin PWM 2 A'])
    assert rows[0]['kind'] == 'combo_fan_header'
    assert rows[0]['count'] == 1
    assert rows[0]['roles'] == ['pump', 'system_fan']


def test_legacy_combined_system_header_total_is_preserved():
    old = [{'kind': 'system_fan_header', 'count': 4,
            'raw': '2 x 4-pin Chassis Fan headers plus 2 x 4-pin Full Speed Fan headers'}]
    assert norm('motherboard_fan_headers', old)[0]['count'] == 4


@pytest.mark.parametrize('value', [
    ['1 x CPU_FAN 4-pin PWM', '2 x CPU_FAN 4-pin PWM'],
    ['1 x SYS_FAN1/PUMP 4-pin PWM', '1 x SYS_FAN1 4-pin PWM'],
    [{'kind': 'cpu_fan_header', 'count': True, 'raw': 'CPU_FAN 4-pin PWM'}],
])
def test_conflicting_counts_or_overlapping_roles_rejected(value):
    with pytest.raises(ValueError):
        norm('motherboard_fan_headers', value)


def test_wrong_voltage_and_alternative_harness_are_unresolved():
    assert norm('cooling_lighting_connectors', ['3-pin 12V ARGB'])[0]['kind'] == 'unresolved'
    assert norm('cooling_lighting_connectors', ['ARGB'])[0]['kind'] == 'unresolved'
    assert norm('aio_pump_connectors', ['4-pin PWM / 3-pin DC'])[0]['kind'] == 'unresolved'
    with pytest.raises(ValueError):
        norm('cooling_lighting_connectors', [{'kind': 'argb_3pin_5v', 'count': 1, 'raw': '4-pin 12V RGB'}])


def test_no_connectors_cannot_hide_a_real_connection():
    with pytest.raises(ValueError):
        norm('cooling_lighting_connectors', ['none', '3-pin 5V ARGB'])


def test_distinct_combo_and_system_headers_can_coexist():
    rows = norm('motherboard_fan_headers', ['1 x SYS_FAN1/PUMP 4-pin PWM 2 A',
                                          '1 x SYS_FAN2 4-pin PWM 1 A'])
    assert len(rows) == 2
    assert norm('motherboard_fan_headers', rows) == rows


def test_manufacturer_header_range_expands_without_duplicates():
    rows = norm('motherboard_fan_headers', ['6 x SYS_FAN1~6 4-pin DC mode 1 A'])
    assert rows[0]['header_ids'] == [f'SYS_FAN{i}' for i in range(1, 7)]
    assert rows[0]['count'] == 6
    assert norm('motherboard_fan_headers', rows) == rows
    with pytest.raises(ValueError):
        norm('motherboard_fan_headers', ['6 x SYS_FAN1~6 4-pin DC mode 1 A', '1 x SYS_FAN3/PUMP 4-pin PWM 2 A'])


def test_connector_lists_and_semicolon_comments_are_not_extra_physical_headers():
    rows = norm('motherboard_fan_headers', ['3 x SYS_FAN1/2/3 4-pin DC 2 A'])
    assert rows[0]['header_ids'] == ['SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3']
    old = norm('motherboard_fan_headers', ['2 x Chassis Fan 4-pin, max 1 A; CHA_FAN2 auto-detects 3-pin or 4-pin fan'])
    assert sum(row['count'] for row in old) == 2
    assert norm('motherboard_fan_headers', old) == old


def test_distinct_lighting_header_groups_do_not_conflict_or_duplicate():
    rows = norm('motherboard_lighting_headers', ['2 x LED_C1/LED_C2 4-pin 12V RGB 2 A',
                                                '1 x CPU_LED1 4-pin 12V RGB 2 A'])
    assert sum(row['count'] for row in rows) == 3
    assert norm('motherboard_lighting_headers', rows) == rows
