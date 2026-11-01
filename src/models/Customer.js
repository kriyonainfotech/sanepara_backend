import mongoose from 'mongoose';

// One GST registration of the customer. A business can hold several (one per state / firm).
const gstSchema = new mongoose.Schema(
  {
    gstNumber: { type: String, required: [true, 'Enter the GST number'], trim: true, uppercase: true },
    firmName: { type: String, trim: true }, // trade / legal name on this registration
    ownerName: { type: String, trim: true }, // proprietor / partner the GSTIN is in the name of
    address: { type: String, trim: true }, // principal place of business of this registration
    notes: { type: String, trim: true },
  },
  { _id: true }
);

const customerSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, required: true, trim: true, match: [/^\d{10}$/, 'Mobile number must be exactly 10 digits'] },
    email: { type: String, trim: true, lowercase: true },
    gsts: [gstSchema],
    // First of `gsts`, kept in sync for screens that show a single GST number (invoices, tasks…).
    gstNumber: { type: String, trim: true, uppercase: true },
    address: { type: String, trim: true },
    referredBy: { type: String, trim: true },
    referredByPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BPartner', default: null },
    notes: { type: String, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

customerSchema.pre('validate', function () {
  this.gstNumber = this.gsts[0]?.gstNumber || '';
});

customerSchema.index({ businessName: 'text', contactPerson: 'text', phone: 'text', gstNumber: 'text' });
customerSchema.index({ 'gsts.gstNumber': 1 });

export const Customer = mongoose.model('Customer', customerSchema);
