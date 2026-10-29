import mongoose from 'mongoose';

const saleSchema = new mongoose.Schema(
  {
    saleNo: { type: String, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerService: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerService' }, // the assigned service billed
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    title: { type: String, required: true, trim: true }, // work description
    saleDate: { type: String, required: true }, // 'YYYY-MM-DD'

    professionalFee: { type: Number, default: 0, min: 0 },
    govtFee: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 }, // professional + govt

    // Kept in sync from payments (see services/sales.js)
    receivedAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 }, // waived / written off
    balance: { type: Number, default: 0 },
    govtReceived: { type: Number, default: 0 },
    status: { type: String, enum: ['Pending', 'Partial', 'Cleared', 'Written Off'], default: 'Pending' },

    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // credited member (incentive)
    b2bPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BPartner' },
    b2bPercent: { type: Number, default: 0, min: 0, max: 100 },
    b2bCommission: { type: Number, default: 0 },
    referredBy: { type: String, trim: true }, // a person (not a B2B partner) who referred the work
    referralAmount: { type: Number, default: 0, min: 0 }, // what that person gets

    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

saleSchema.index({ saleDate: -1 });
saleSchema.index({ customer: 1, saleDate: -1 });
saleSchema.index({ b2bPartner: 1, saleDate: -1 });
saleSchema.index({ customerService: 1 });

export const Sale = mongoose.model('Sale', saleSchema);
