import mongoose from 'mongoose';

// One record per member per day.
const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD' (India)
    clockIn: { type: Date },
    clockOut: { type: Date },
    inTime: { type: String }, // 'HH:mm'
    outTime: { type: String },
    totalHours: { type: Number, default: 0 },
    // Working = clocked in, not out yet
    status: { type: String, enum: ['Working', 'Full Day', 'Half Day', 'Absent', 'Leave'], default: 'Working' },
    isLate: { type: Boolean, default: false },
    lateMinutes: { type: Number, default: 0 },
    autoClockOut: { type: Boolean, default: false },
    manual: { type: Boolean, default: false }, // status set/edited by admin
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });

export const Attendance = mongoose.model('Attendance', attendanceSchema);
