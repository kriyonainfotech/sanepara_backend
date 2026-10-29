import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Please add a task title'], trim: true, maxlength: 200 },
    description: { type: String, trim: true },
    // Personal = own / superadmin tasks, Admin = given to an admin, Team = given to a team member
    type: { type: String, enum: ['Personal', 'Team', 'Admin'], default: 'Personal', required: true },
    status: { type: String, default: 'Pending' },
    priority: { type: String, default: 'Medium' },
    dueDate: { type: String, required: [true, 'Please add a due date'] }, // 'YYYY-MM-DD'
    taskTime: { type: String }, // 'HH:mm'
    taskCategory: { type: String, default: 'General' },
    isDailyTask: { type: Boolean, default: false },
    completedAt: { type: Date },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    scheduleItem: { type: mongoose.Schema.Types.ObjectId, ref: 'ScheduleItem' },
    customerService: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerService' }, // service bunch
    order: { type: Number, default: 0 }, // position inside the bunch
    dailyRule: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyTaskRule' },

    checklistTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'ChecklistTemplate' },
    checklist: [{ text: String, isCompleted: { type: Boolean, default: false }, completedAt: Date }],
    requiresChecklistCompletion: { type: Boolean, default: false },

    statusHistory: [
      {
        status: String,
        note: String,
        updatedAt: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    pendingReasons: [
      {
        reason: String,
        date: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
  },
  { timestamps: true }
);

taskSchema.index({ assignedTo: 1, dueDate: 1 });
taskSchema.index({ type: 1, dueDate: 1 });
taskSchema.index({ client: 1 });
taskSchema.index({ customerService: 1, order: 1 });

export const Task = mongoose.model('Task', taskSchema);
