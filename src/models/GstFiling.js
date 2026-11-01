import mongoose from 'mongoose';

// A GST registration (GSTIN) of a customer whose returns the firm is filing. A customer with
// several GSTINs has one filing per GSTIN; '' = customer has no GSTIN saved yet.
const gstFilingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    gstNumber: { type: String, trim: true, uppercase: true, default: '' },
    firmName: { type: String, trim: true, default: '' }, // copied from the customer's GST entry
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
    // GST portal login. Password is encrypted (utils/secretBox.js); only returned by
    // GET /:id/login to members with GST Filing → GST portal login.
    portalLogin: {
      type: new mongoose.Schema(
        {
          username: { type: String, trim: true },
          password: { type: String },
          updatedAt: Date,
          updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
        { _id: false }
      ),
      select: false,
    },
  },
  { timestamps: true }
);

gstFilingSchema.index({ isRunning: 1 });
gstFilingSchema.index({ customer: 1, gstNumber: 1 }, { unique: true });

export const GstFiling = mongoose.model('GstFiling', gstFilingSchema);
