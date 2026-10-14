import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_pc_catalog', ROOT / 'tools/audit_pc_catalog.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
POLICY = json.loads((ROOT / 'config/supplier-delivery.json').read_text(encoding='utf-8'))


class SupplierPolicyTests(unittest.TestCase):
    def test_route_matrix_covers_all_workbook_combinations(self):
        cities = POLICY['destinationCities']
        self.assertEqual(sum(not warehouse.get('excludeInventory', False) for warehouse in POLICY['warehouses']), 18)
        self.assertEqual(len(POLICY['warehouses']), 20)
        for warehouse in POLICY['warehouses']:
            self.assertEqual(set(warehouse['deliveries']), set(cities))

    def test_closed_and_retired_supplier_stocks_are_excluded(self):
        excluded = POLICY['availabilityPolicy']['excludedSupplierLabels']
        for supplier in excluded:
            product = {'dealersData': [f'{supplier} (999) - 1 / 1 / 1']}
            self.assertFalse(audit.has_positive_dealer_quantity(product, excluded))

    def test_active_supplier_stock_still_counts(self):
        excluded = POLICY['availabilityPolicy']['excludedSupplierLabels']
        product = {'dealersData': [
            'VENDER_P_S (50) - 1 / 1 / 1',
            'VENDER_P (3) - 1 / 1 / 1',
        ]}
        self.assertTrue(audit.has_positive_dealer_quantity(product, excluded))

    def test_vendor_group_and_large_order_threshold_are_recorded(self):
        group = POLICY['availabilityPolicy']['companyGroups'][0]
        self.assertEqual(group['supplierLabels'], ['VENDER_S', 'VENDER_P', 'VENDER_G'])
        self.assertEqual(group['specialRequestQuantityAbove'], 50)
        self.assertIn('VENDER_P_S', POLICY['availabilityPolicy']['excludedSupplierLabels'])

    def test_prohibited_route_is_distinct_from_zero_day_local_delivery(self):
        by_label = {warehouse['label']: warehouse for warehouse in POLICY['warehouses']}
        self.assertIsNone(by_label['OVER AS']['deliveries']['Алматы'])
        self.assertEqual(by_label['OVER AS']['deliveries']['Астана'], 0)
        self.assertIsNone(by_label['OVER ALB']['deliveries']['Алматы'])


if __name__ == '__main__':
    unittest.main()
