import mongoose from 'mongoose';

// A service assigned to a customer. Its tasks become schedule items; the
// status here is derived from those items (see services/scheduleSync.js).
const customerServiceSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
      default: 'pending',
    },
    completedAt: { type: Date },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Set on the monthly / quarterly GST work created from Running GST Filing (jobs/gstWork.js).
    gstFiling: { type: mongoose.Schema.Types.ObjectId, ref: 'GstFiling' },
    gstReturnType: { type: String },
    period: { type: String }, // 'YYYY-MM' or 'YYYY-Qn'
    periodLabel: { type: String }, // 'Sep 2026', 'Jul–Sep 2026'
  },
  { timestamps: true }
);

customerServiceSchema.index({ period: 1, gstReturnType: 1 }, { sparse: true });

export const CustomerService = mongoose.model('CustomerService', customerServiceSchema);
