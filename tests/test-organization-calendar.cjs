const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSchedule,routeSchedule} = require('../tools/branch-calendar.cjs');
test('Friday transfer skips holiday Monday and assembly uses working days', () => {
  const calendar = {calendar_exceptions:[{date:'2026-11-02',working:false}]};
  const result = routeSchedule('2026-10-30T05:00:00Z', 1, 2, calendar, calendar);
  assert.equal(result.arrivalDate,'2026-11-03');
  assert.equal(result.readyDate,'2026-11-05');
});
test('working Saturday overrides weekly weekend and zero-day start normalizes', () => {
  const calendar = {calendar_exceptions:[{date:'2026-10-31',working:true}]};
  assert.equal(routeSchedule('2026-10-30T05:00:00Z',1,0,calendar,calendar).readyDate,'2026-10-31');
  assert.equal(buildSchedule('2026-10-31T05:00:00Z',0,{assembly_workdays:0}).readyDate,'2026-11-02');
});

test('sender days control transit, receiver days control reception and assembly', () => {
  const result = routeSchedule('2026-10-30T05:00:00Z',1,2,{weekly_days_off:[6]},{weekly_days_off:[0,5,6]});
  assert.equal(result.arrivalDate,'2026-11-03');
  assert.equal(result.readyDate,'2026-11-05');
});

test('PC assembly waits for the latest actual arrival across different warehouse calendars', () => {
  const operations = {version:7,assembly_workdays:2,branches:[
    {code:'A',source_label:'Stock A',active:true,kind:'warehouse',weekly_days_off:[0,1,2,3,4,6]},
    {code:'B',active:true,kind:'warehouse',weekly_days_off:[]},
    {code:'C',active:true,kind:'branch',city:'Алматы',weekly_days_off:[5,6]},
  ],routes:[{from_branch:'A',to_branch:'C',workdays:1},{from_branch:'B',to_branch:'C',workdays:2}]};
  const result = buildSchedule('2026-10-30T05:00:00Z',2,operations,{destinationCity:'Алматы',parts:[{supplier:'Stock A'},{supplier:'B'}]});
  assert.equal(result.arrivalDate,'2026-11-09');
  assert.equal(result.readyDate,'2026-11-11');
  assert.equal(result.calendarVersion,7);
  assert.throws(()=>buildSchedule('2026-10-30T05:00:00Z',2,operations,{destinationCity:'Алматы',parts:[{supplier:'missing'}]}));
  assert.throws(()=>buildSchedule('2026-10-30T05:00:00Z',2,{}, {requireBranches:true}));
});
test('Kazakhstan date is used across UTC midnight and year boundary', () => {
  assert.equal(buildSchedule('2026-12-31T20:00:00Z',0,{assembly_workdays:0}).startDate,'2027-01-01');
});
