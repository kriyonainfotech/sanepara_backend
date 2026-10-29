import mongoose from 'mongoose';

// A business partner who brings customers and earns a % of the professional fee.
const b2bPartnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    firmName: { type: String, trim: true },
    phone: { type: String, trim: true, match: [/^\d{10}$/, 'Mobile number must be exactly 10 digits'] },
    email: { type: String, trim: true, lowercase: true },
    percentage: { type: Number, required: true, min: 0, max: 100 },
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const B2BPartner = mongoose.model('B2BPartner', b2bPartnerSchema);
