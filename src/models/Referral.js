import mongoose from 'mongoose';

// A team member refers a service to a customer. When it is sold, the
// referral is converted and the member earns the incentive.
const referralSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    referredOn: { type: String, required: true }, // 'YYYY-MM-DD'
    note: { type: String, trim: true },
    status: { type: String, enum: ['Pending', 'Converted', 'Rejected'], default: 'Pending' },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
    convertedOn: { type: String }, // incentive counts in this month (payroll)
    incentive: { type: Number, default: 0, min: 0 },
    rejectReason: { type: String, trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

referralSchema.index({ referredBy: 1, referredOn: -1 });
referralSchema.index({ status: 1, convertedOn: 1 });

export const Referral = mongoose.model('Referral', referralSchema);
