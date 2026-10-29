import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, required: true, trim: true, match: [/^\d{10}$/, 'Mobile number must be exactly 10 digits'] },
    email: { type: String, trim: true, lowercase: true },
    gstNumber: { type: String, trim: true, uppercase: true },
    address: { type: String, trim: true },
    referredBy: { type: String, trim: true },
    referredByPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BPartner', default: null },
    notes: { type: String, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

customerSchema.index({ businessName: 'text', contactPerson: 'text', phone: 'text', gstNumber: 'text' });

export const Customer = mongoose.model('Customer', customerSchema);
