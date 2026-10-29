import mongoose from 'mongoose';

// Every sale gets one invoice (INV-0001…), created automatically.
const invoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: String, required: true, unique: true },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true, unique: true },
    invoiceDate: { type: String, required: true }, // 'YYYY-MM-DD'
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

invoiceSchema.index({ invoiceDate: -1 });

export const Invoice = mongoose.model('Invoice', invoiceSchema);
