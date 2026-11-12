from app.performance_models import files, group_models, identify


def product(pid, name='GeForce RTX 5070', memory=12):
    return dict(id=pid, type='gpu', name='Видеокарта '+name, sku=str(pid),
                manufacturer='Gigabyte', selection_enabled=True, validity_check=True,
                attributes={'gpu_graphics_processor': name, 'gpu_memory_gb': memory})


def test_model_groups_variants_and_separates_memory_and_workload():
    registry, data = files()
    products = [product(1), product(2), product(3, memory=24), product(4, 'Radeon AI PRO R9700', 32)]
    groups = group_models(products, 'gaming', registry, data)
    measured = [row for row in groups if row['status'] == 'measured']
    assert len(measured) == 1 and len(measured[0]['products']) == 2
    assert len(groups) == 3
    assert all(row['status'] == 'not_evaluated' for row in group_models(products, 'creative', registry, data))


def test_missing_identity_is_not_merged_and_cpu_suffix_is_preserved():
    registry, data = files()
    assert identify('cpu', 'Intel Core i5-12600KF BOX', 'Intel', {}, registry)[0] == 'Intel Core i5 12600KF'
    assert identify('cpu', 'AMD Ryzen 5 7600 OEM', 'Intel', {}, registry)[0] is None
    assert len(group_models([product(1, ''), product(2, '')], 'gaming', registry, data)) == 2


def test_creative_evidence_is_specific_to_application_and_gpu_memory():
    registry, data = files()
    registry['workloadObservations'] = [dict(id='fixture', version='4.0', application='blender',
        operation='gpu_render', component='gpu', url='https://example.com/test', date='2024-01-01',
        metric='samples/min', baseValue=100, direction='higher',
        observations=[dict(model='GeForce RTX 5070', memoryGB=12, value=120)])]
    assert group_models([product(1)], 'blender_gpu', registry, data)[0]['status'] == 'measured'
    for scenario in ['photoshop', 'twinmotion', 'blender_cpu']:
        assert group_models([product(1)], scenario, registry, data)[0]['status'] == 'not_evaluated'
    assert group_models([product(1, memory=24)], 'blender_gpu', registry, data)[0]['status'] == 'not_evaluated'


def test_reference_twinmotion_cohort_is_not_marked_as_ranking_ready():
    registry, data = files()
    row = group_models([product(1, 'NVIDIA RTX 4000 Ada Generation', 20)], 'twinmotion', registry, data)[0]
    assert row['status'] == 'reference_only'
    assert row['evidence'][0]['scope']
