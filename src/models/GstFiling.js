import mongoose from 'mongoose';

// A customer whose GST return the firm is currently filing.
const gstFilingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    returnType: { type: String, enum: ['Monthly', 'Quarterly (QRMP)', 'Composition'], default: 'Monthly' },
    isRunning: { type: Boolean, default: true },
    startedOn: { type: String, required: true }, // 'YYYY-MM-DD'
    stoppedOn: { type: String },
    notes: { type: String, trim: true },
    history: [
      {
        action: { type: String, enum: ['Started', 'Stopped', 'Resumed'] },
        date: String,
        note: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      },
    ],
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Periods whose GST work was already created, so deleting that work does not bring it back.
    workPeriods: [String],
  },
  { timestamps: true }
);

gstFilingSchema.index({ isRunning: 1 });

export const GstFiling = mongoose.model('GstFiling', gstFilingSchema);
