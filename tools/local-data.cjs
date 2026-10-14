'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {getOffer} = require('./pc-builder.cjs');

class LocalDataError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new LocalDataError('local_data_invalid'); }
}

function containsLinkField(value) {
  if (Array.isArray(value)) return value.some(containsLinkField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(url|href|link)$/i.test(key) || containsLinkField(child));
}

function nonEmptyText(value) { return typeof value === 'string' && value.trim().length > 0; }
function validEvidenceSource(source) {
  return !!source && nonEmptyText(source.manufacturer) && nonEmptyText(source.pageTitle) &&
    nonEmptyText(source.checkedAt) && !Number.isNaN(Date.parse(source.checkedAt)) &&
    nonEmptyText(source.reviewedBy);
}
function validMerchantProductDetails(details) {
  if (!Array.isArray(details) || details.length > 100) return false;
  const seen = new Set();
  for (const detail of details) {
    if (!detail || !nonEmptyText(detail.sectionName) || !nonEmptyText(detail.attributeName) ||
        !nonEmptyText(detail.attributeValue) || detail.sectionName.length > 150 ||
        detail.attributeName.length > 150 || detail.attributeValue.length > 150) return false;
    const key = `${detail.sectionName.trim().toLocaleLowerCase()}\u0000${detail.attributeName.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function createLocalData(root = path.join(__dirname, '..')) {
  const catalog = readJson(path.join(root, 'data', 'p1-catalog.json'));
  const evidence = readJson(path.join(root, 'data', 'component-characteristics.json'));
  let supplierPolicy;
  try { supplierPolicy = readJson(path.join(root, 'config', 'supplier-delivery.json')); }
  catch { supplierPolicy = null; }
  if (!catalog || !Array.isArray(catalog.items) || !catalog.items.length ||
      !Number.isInteger(catalog.totalElements) || catalog.totalElements !== catalog.items.length ||
      !nonEmptyText(catalog.downloadedAtUtc) || !evidence || evidence.schemaVersion !== 1 ||
      !Array.isArray(evidence.components) || !Array.isArray(evidence.compatibilityChecks) ||
      containsLinkField(evidence)) throw new LocalDataError('local_data_invalid');

  const bySku = new Map();
  for (const product of catalog.items) {
    const sku = String(product?.skuOver ?? '');
    if (!/^\d+$/.test(sku) || bySku.has(sku)) throw new LocalDataError('local_catalog_identity_invalid');
    bySku.set(sku, product);
  }

  const componentBySku = new Map();
  for (const component of evidence.components) {
    const sku = String(component?.skuOver ?? '');
    const product = bySku.get(sku);
    if (!/^\d+$/.test(sku) || componentBySku.has(sku) || !product ||
        component.article !== product.article || component.manufacturer !== product.manufacturer ||
        !nonEmptyText(component.category) || !nonEmptyText(component.article) ||
        !nonEmptyText(component.manufacturer) || !nonEmptyText(component.officialModel) ||
        !component.facts || typeof component.facts !== 'object' ||
        Array.isArray(component.facts) || !Object.keys(component.facts).length ||
        !['needs_review', 'verified', 'rejected'].includes(component.status)) {
      throw new LocalDataError('local_evidence_identity_invalid');
    }
    if (Object.entries(component.facts).some(([key, fact]) => !nonEmptyText(key) || !fact ||
        typeof fact !== 'object' || !Object.hasOwn(fact, 'value') || !validEvidenceSource(fact.source))) {
      throw new LocalDataError('local_evidence_fact_invalid');
    }
    if (component.status === 'verified' &&
        (!nonEmptyText(component.reviewedAt) || !nonEmptyText(component.reviewedBy) ||
          !validMerchantProductDetails(component.merchantProductDetails))) {
      throw new LocalDataError('local_evidence_review_invalid');
    }
    componentBySku.set(sku, component);
  }

  const checks = [];
  const checkPairs = new Set();
  for (const check of evidence.compatibilityChecks) {
    const left = String(check?.leftSkuOver ?? '');
    const right = String(check?.rightSkuOver ?? '');
    const pair = [left, right].sort().join(':');
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right) || left === right || checkPairs.has(pair) ||
        componentBySku.get(left)?.status !== 'verified' || componentBySku.get(right)?.status !== 'verified' ||
        !['compatible', 'incompatible', 'unknown'].includes(check.result) || !nonEmptyText(check.reason) ||
        !Array.isArray(check.sources) || !check.sources.length ||
        !check.sources.every(validEvidenceSource) || !nonEmptyText(check.checkedAt) ||
        Number.isNaN(Date.parse(check.checkedAt)) || !nonEmptyText(check.reviewedBy) ||
        (check.result !== 'unknown' && (!Array.isArray(check.factReferences) || check.factReferences.length < 2))) {
      throw new LocalDataError('local_compatibility_record_invalid');
    }
    checkPairs.add(pair);
    checks.push(check);
  }

  const verified = new Map([...componentBySku].filter(([, component]) => component.status === 'verified'));
  const warehouses = new Map((supplierPolicy?.warehouses || []).map(row => [row.label, row]));
  function getBuildCandidates(city) {
    const result = [];
    for (const [sku, component] of verified) {
      const product = bySku.get(sku);
      if (!product || product.isArchived || !Number.isSafeInteger(product.priceLoan) || product.priceLoan <= 0) continue;
      const offer = getOffer(product, warehouses, city);
      if (offer) result.push({skuOver:sku,category:component.category,component:structuredClone(component),product:structuredClone(product),offer});
    }
    return result;
  }
  function getVerifiedComponent(sku) {
    const component = verified.get(String(sku));
    return component ? structuredClone(component) : null;
  }
  function getCompatibility(leftSku, rightSku) {
    const left = String(leftSku); const right = String(rightSku);
    const check = checks.find(row => (row.leftSkuOver === left && row.rightSkuOver === right) ||
      (row.leftSkuOver === right && row.rightSkuOver === left));
    return check ? structuredClone(check) : null;
  }
  function status() {
    return {
      catalogLoaded: true,
      snapshotAt: catalog.downloadedAtUtc,
      itemCount: catalog.items.length,
      evidenceDatabaseLoaded: true,
      verifiedComponentCount: verified.size,
      compatibilityCheckCount: checks.length,
      buildEngineReady: !!supplierPolicy && warehouses.size > 0,
      buildsReady: false
    };
  }
  return {status, getVerifiedComponent, getCompatibility, getBuildCandidates};
}

module.exports = {LocalDataError, createLocalData};
