'use strict';

function calendarDate(createdAt) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(createdAt));
  const part = name => parts.find(p => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addWorkdays(start, count, calendar = {}) {
  const off = calendar.weekly_days_off ?? [5, 6];
  if (!Number.isInteger(count) || count < 0 || count > 365 || !Array.isArray(off) || off.length > 6 ||
      off.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(off).size !== off.length)
    throw new Error('Invalid branch calendar');
  const exceptions = new Map((calendar.calendar_exceptions ?? []).map(row => [row.date, row.working]));
  const day = new Date(`${start}T00:00:00Z`);
  const date = () => day.toISOString().slice(0, 10);
  const working = () => exceptions.has(date()) ? exceptions.get(date()) : !off.includes((day.getUTCDay() + 6) % 7);
  const next = () => day.setUTCDate(day.getUTCDate() + 1);
  let guard = 0;
  while (!working()) { if (++guard > 4000) throw new Error('No working date'); next(); }
  while (count) { if (++guard > 8000) throw new Error('No working date'); next(); if (working()) count--; }
  return date();
}

function routeSchedule(createdAt, transferDays, assemblyDays, source, target) {
  const startDate = addWorkdays(calendarDate(createdAt), 0, source);
  const arrivalDate = addWorkdays(addWorkdays(startDate, transferDays, source), 0, target);
  return { startDate, arrivalDate, readyDate: addWorkdays(arrivalDate, assemblyDays, target) };
}

function buildSchedule(createdAt, transferDays, operations = {}, context = {}) {
  const assemblyDays = operations.assembly_workdays ?? 2;
  const branches = operations.branches ?? [];
  let schedule;
  if (branches.length) {
    const destinations = branches.filter(b => b.active && (b.kind ?? 'branch') === 'branch' && b.city === context.destinationCity && (!context.destinationBranch || b.code === context.destinationBranch));
    if (destinations.length !== 1 || !context.parts?.length) throw new Error('Assembly branch requires review');
    const target = destinations[0];
    const deliveries = context.parts.map(part => {
      const sources = branches.filter(b => b.active && (b.source_label || b.code) === part.supplier);
      if (sources.length !== 1) throw new Error('Source warehouse requires review');
      const source = sources[0];
      const days = source.code === target.code ? 0 : (operations.routes ?? []).find(r => r.from_branch === source.code && r.to_branch === target.code)?.workdays;
      return routeSchedule(createdAt, days, 0, source, target);
    });
    // A shorter route may arrive later because of the source warehouse's days off.
    const startDate = deliveries.map(d => d.startDate).sort()[0];
    const arrivalDate = deliveries.map(d => d.arrivalDate).sort().at(-1);
    schedule = { startDate, arrivalDate, readyDate: addWorkdays(arrivalDate, assemblyDays, target) };
  } else {
    if (context.requireBranches) throw new Error('Organization warehouses are not configured');
    // Historical standalone fixtures without organization logistics use the default week.
    schedule = routeSchedule(createdAt, transferDays, assemblyDays, {}, {});
  }
  return { assemblyBusinessDays: assemblyDays, totalBusinessDays: transferDays + assemblyDays,
    ...schedule, calendarVersion: operations.version ?? 0 };
}
module.exports = { buildSchedule, routeSchedule, addWorkdays };
