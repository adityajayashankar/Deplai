import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  amountInWordsInr,
  formatInvoiceNumber,
  gstSplit,
  indianFinancialYear,
  quoteInrCharge,
  usdCentsToInrPaise,
} from './money';

describe('usdCentsToInrPaise', () => {
  it('converts list prices at the fixed 83 rate', () => {
    assert.equal(usdCentsToInrPaise(2000, 83), 166000);
    assert.equal(usdCentsToInrPaise(5000, 83), 415000);
    assert.equal(usdCentsToInrPaise(1200, 83), 99600);
  });
});

describe('gstSplit', () => {
  it('uses CGST+SGST for same-state supply', () => {
    const quote = gstSplit({
      taxablePaise: 166000,
      gstPercent: 18,
      sellerStateCode: '29',
      buyerStateCode: '29',
    });
    assert.equal(quote.taxSplit, 'intra');
    assert.equal(quote.cgstPaise, 14940);
    assert.equal(quote.sgstPaise, 14940);
    assert.equal(quote.igstPaise, 0);
    assert.equal(quote.totalPaise, 195880);
  });

  it('uses IGST for inter-state supply', () => {
    const quote = gstSplit({
      taxablePaise: 166000,
      gstPercent: 18,
      sellerStateCode: '29',
      buyerStateCode: '27',
    });
    assert.equal(quote.taxSplit, 'inter');
    assert.equal(quote.cgstPaise, 0);
    assert.equal(quote.igstPaise, 29880);
    assert.equal(quote.totalPaise, 195880);
  });

  it('defaults missing buyer state to intra-state', () => {
    const quote = gstSplit({
      taxablePaise: 10000,
      gstPercent: 18,
      sellerStateCode: '29',
      buyerStateCode: null,
    });
    assert.equal(quote.taxSplit, 'intra');
  });
});

describe('quoteInrCharge', () => {
  it('never takes a client-supplied INR amount', () => {
    const quote = quoteInrCharge({
      usdCents: 5000,
      usdToInr: 83,
      gstPercent: 18,
      sellerStateCode: '29',
      buyerStateCode: '29',
    });
    assert.equal(quote.displayAmountCents, 5000);
    assert.equal(quote.taxablePaise, 415000);
    assert.equal(quote.totalPaise, 489700);
  });
});

describe('invoice numbering helpers', () => {
  it('uses the Indian financial year in UTC', () => {
    assert.deepEqual(indianFinancialYear(new Date('2026-03-31T12:00:00.000Z')), { fy: '2526', label: '25-26' });
    assert.deepEqual(indianFinancialYear(new Date('2026-04-01T00:00:00.000Z')), { fy: '2627', label: '26-27' });
  });

  it('zero-pads serials', () => {
    assert.equal(formatInvoiceNumber('DPL', '26-27', 1), 'DPL/26-27/000001');
  });
});

describe('amountInWordsInr', () => {
  it('renders rupees and paise', () => {
    assert.equal(amountInWordsInr(195880), 'INR One Thousand Nine Hundred Fifty Eight and Paise Eighty Only');
  });
});
