'use strict';

// Recorded PPT/MTP takes priority over the owner's cooling estimates.
function cpuCoolingPower(spec, model = '') {
  const positive = value => Number.isFinite(value) && value > 0;
  const amd = /^AM[45]$/i.test(spec?.socket || '') || /\bAMD\b|\bRyzen\b/i.test(model);
  if (amd) {
    if (positive(spec?.pptW)) return spec.pptW;
    if (!positive(spec?.tdpW)) return null;
    const highEnd = /Ryzen\s*[79]\b/i.test(`${model} ${spec.series || ''}`);
    return Math.ceil(spec.tdpW * (highEnd ? 1.5 : 1.35));
  }
  if (positive(spec?.maxTurboPowerW)) return spec.maxTurboPowerW;
  if (!positive(spec?.tdpW)) return null;
  const identity = `${model} ${spec?.series || ''}`;
  if (/\bCeleron\b|\bPent(?:ium)?\b|\bCore\s+i3\b/i.test(identity)) return spec.tdpW;
  if (/\bCore\s+i[57]\b/i.test(identity)) return Math.ceil(spec.tdpW * 1.35);
  return null;
}
module.exports = {cpuCoolingPower};
