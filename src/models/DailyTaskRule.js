import mongoose from 'mongoose';

// Generates tasks automatically: every evening at 7 PM for the next day
// (never for Sunday), or on demand via "Trigger Now".
const dailyTaskRuleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
    isActive: { type: Boolean, default: true },
    frequency: { type: String, enum: ['Daily', 'Weekly', 'Monthly', 'Yearly'], default: 'Daily' },
    daysOfWeek: { type: [Number], default: [] }, // 0 = Sunday … 6 = Saturday
    dateOfMonth: { type: Number, min: 1, max: 31 },
    monthOfYear: { type: Number, min: 1, max: 12 },
    isChecklistTask: { type: Boolean, default: false },
    checklistTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'ChecklistTemplate' },
    customChecklist: [{ type: String, trim: true }],
    lastGeneratedFor: { type: String }, // 'YYYY-MM-DD' the 7 PM job last handled
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const DailyTaskRule = mongoose.model('DailyTaskRule', dailyTaskRuleSchema);
