import mongoose from 'mongoose';

// A due date added by the firm on the Compliance Calendar (trademark renewal, hearing,
// ROC filing…), optionally for one customer and repeating.
const complianceItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Add a title'], trim: true, maxlength: [120, 'Title can be at most 120 characters'] },
    category: { type: String, default: 'Other' },
    dueDate: { type: String, required: [true, 'Pick the due date'] }, // 'YYYY-MM-DD' (first occurrence)
    repeat: { type: String, enum: ['none', 'monthly', 'quarterly', 'yearly'], default: 'none' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    notes: { type: String, trim: true },
    completed: [String], // occurrence dates marked done
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const ComplianceItem = mongoose.model('ComplianceItem', complianceItemSchema);
