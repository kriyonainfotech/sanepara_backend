import { HttpError } from './asyncHandler.js';

export const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const cleanGstNumber = (v) => String(v ?? '').toUpperCase().replace(/\s/g, '');

// Firm fields (copied onto services / sales) for one of the customer's GSTINs; '' = the customer itself.
export function firmOf(customer, gstNumber) {
  const n = cleanGstNumber(gstNumber);
  if (!n) return { gstNumber: '', firmName: '', ownerName: '' };
  const g = customer?.gsts?.find((x) => x.gstNumber === n);
  if (!g) throw new HttpError(400, `GST number ${n} is not one of this customer’s firms`);
  return { gstNumber: g.gstNumber, firmName: g.firmName || '', ownerName: g.ownerName || '' };
}

// A customer's GST registrations from a form: trimmed, checked, no GSTIN twice.
// Older clients still send a single `gstNumber`.
export function gstsFrom(body) {
  const list = Array.isArray(body.gsts) ? body.gsts : body.gstNumber ? [{ gstNumber: body.gstNumber }] : [];
  const out = [];
  for (const g of list) {
    const gstNumber = cleanGstNumber(g?.gstNumber);
    const firmName = String(g?.firmName ?? '').trim();
    if (!gstNumber && !firmName) continue;
    if (!GST_RE.test(gstNumber)) throw new HttpError(400, `GST number "${gstNumber || firmName}" looks wrong (15 characters, e.g. 24ABCDE1234F1Z5)`);
    if (out.some((x) => x.gstNumber === gstNumber)) throw new HttpError(400, `GST number ${gstNumber} is added twice`);
    out.push({
      ...(g._id && { _id: g._id }),
      gstNumber,
      firmName,
      ownerName: String(g.ownerName ?? '').trim(),
      address: String(g.address ?? '').trim(),
      notes: String(g.notes ?? '').trim(),
    });
  }
  return out;
}
