'use strict';

// The organization settings returned by CoreLab are the sole live routing source.
function organizationWarehouses(operations, destinationBranch) {
  const branches = operations?.branches ?? [];
  const routes = operations?.routes ?? [];
  const destinations = new Map();
  for (const branch of branches) {
    if (!branch.active || (branch.kind ?? 'branch') !== 'branch' || !branch.city) continue;
    if (destinationBranch && branch.code !== destinationBranch) continue;
    const matches = destinations.get(branch.city) ?? [];
    destinations.set(branch.city, [...matches, branch.code]);
  }
  const warehouses = new Map();
  for (const source of branches) {
    if (!source.active || !source.city) continue;
    const deliveries = {};
    for (const [city, targets] of destinations) {
      // Until the customer selects a specific branch, ambiguous city routes require review.
      if (targets.length !== 1) continue;
      if (source.code === targets[0]) { deliveries[city] = 0; continue; }
      const route = routes.find(r => r.from_branch === source.code && r.to_branch === targets[0]);
      if (Number.isInteger(route?.workdays) && route.workdays >= 0) deliveries[city] = route.workdays;
    }
    warehouses.set(source.source_label || source.code, {city:source.city,deliveries});
  }
  return warehouses;
}
module.exports = {organizationWarehouses};
