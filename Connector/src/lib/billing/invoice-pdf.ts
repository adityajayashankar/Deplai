import PDFDocument from 'pdfkit';
import { amountInWordsInr, formatInrFromPaise, formatUsdFromCents } from './money';
import { type BillingInvoice } from './invoices';

function bufferPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function line(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.font('Helvetica').fontSize(9).fillColor('#334155').text(label, { continued: true });
  doc.font('Helvetica-Bold').fillColor('#0f172a').text(` ${value}`);
}

export async function renderInvoicePdf(invoice: BillingInvoice): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const done = bufferPdf(doc);

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text('TAX INVOICE');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Computer-generated GST tax invoice');
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(invoice.sellerLegalName);
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  if (invoice.sellerAddress) doc.text(invoice.sellerAddress);
  line(doc, 'GSTIN', invoice.sellerGstin || 'Not registered — set BILLING_GSTIN before live billing');
  if (invoice.sellerStateName) line(doc, 'State', `${invoice.sellerStateCode || ''} ${invoice.sellerStateName}`.trim());

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Bill to');
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  doc.text(invoice.buyerName);
  doc.text(invoice.buyerEmail);
  if (invoice.buyerAddress) doc.text(invoice.buyerAddress);
  if (invoice.buyerGstin) line(doc, 'GSTIN', invoice.buyerGstin);
  if (invoice.placeOfSupply) line(doc, 'Place of supply', invoice.placeOfSupply);
  line(doc, 'Reverse charge', invoice.reverseCharge ? 'Yes' : 'No');

  doc.moveDown(0.8);
  line(doc, 'Invoice number', invoice.invoiceNumber);
  line(doc, 'Invoice date', invoice.invoiceDate);
  line(doc, 'Status', invoice.status.toUpperCase());

  doc.moveDown(1);
  const tableTop = doc.y;
  doc.rect(48, tableTop, 499, 22).fill('#0f172a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
  doc.text('Description', 56, tableTop + 7, { width: 210 });
  doc.text('SAC', 270, tableTop + 7, { width: 50 });
  doc.text('Taxable', 330, tableTop + 7, { width: 70, align: 'right' });
  doc.text('Tax', 410, tableTop + 7, { width: 50, align: 'right' });
  doc.text('Total', 470, tableTop + 7, { width: 69, align: 'right' });

  const taxPaise = invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise;
  doc.fillColor('#0f172a').font('Helvetica').fontSize(9);
  doc.text(invoice.description, 56, tableTop + 30, { width: 210 });
  doc.text(invoice.hsnSac, 270, tableTop + 30, { width: 50 });
  doc.text(formatInrFromPaise(invoice.taxablePaise), 330, tableTop + 30, { width: 70, align: 'right' });
  doc.text(formatInrFromPaise(taxPaise), 410, tableTop + 30, { width: 50, align: 'right' });
  doc.text(formatInrFromPaise(invoice.totalPaise), 470, tableTop + 30, { width: 69, align: 'right' });

  doc.y = tableTop + 70;
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  if (invoice.cgstPaise) line(doc, `CGST @ ${invoice.cgstRate}%`, formatInrFromPaise(invoice.cgstPaise));
  if (invoice.sgstPaise) line(doc, `SGST @ ${invoice.sgstRate}%`, formatInrFromPaise(invoice.sgstPaise));
  if (invoice.igstPaise) line(doc, `IGST @ ${invoice.igstRate}%`, formatInrFromPaise(invoice.igstPaise));
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a');
  doc.text(`Grand total  ${formatInrFromPaise(invoice.totalPaise)}`);
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor('#334155').text(amountInWordsInr(invoice.totalPaise));
  doc.moveDown(0.4);
  doc.text(`Listed price ${formatUsdFromCents(invoice.displayAmountCents)} ${invoice.displayCurrency} (converted and taxed in INR).`);

  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Payment proof');
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  if (invoice.razorpayOrderId) line(doc, 'Razorpay order', invoice.razorpayOrderId);
  if (invoice.razorpaySubscriptionId) line(doc, 'Razorpay subscription', invoice.razorpaySubscriptionId);
  if (invoice.razorpayPaymentId) line(doc, 'Razorpay payment', invoice.razorpayPaymentId);

  doc.moveDown(1.5);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b')
    .text('This is a computer-generated invoice. IRN/e-invoice registration is not included in this document.');

  doc.end();
  return done;
}
