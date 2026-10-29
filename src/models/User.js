import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const ROLES = ['superadmin', 'admin', 'team'];
// Super Admins do not clock in, so they are left out of attendance and payroll.
export const CLOCKING_ROLES = ['admin', 'team'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, match: [/^\d{10}$/, 'Mobile number must be exactly 10 digits'] },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'team' },
    designation: { type: String, trim: true },
    monthlySalary: { type: Number, default: 0, min: 0 },
    // Shift & attendance rules
    shiftStart: { type: String, default: '09:00', match: /^\d{2}:\d{2}$/ }, // after this = late
    shiftEnd: { type: String, default: '18:00', match: /^\d{2}:\d{2}$/ },
    fullDayHours: { type: Number, default: 8, min: 0, max: 24 }, // worked ≥ this = Full Day
    halfDayHours: { type: Number, default: 4, min: 0, max: 24 }, // worked ≥ this = Half Day, else Absent
    joiningDate: { type: Date },
    isActive: { type: Boolean, default: true },
    // Deleted members stay in the database so old tasks, attendance, sales and
    // salary records keep their name; they are hidden everywhere and cannot log in.
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.pre('save', async function () {
  if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

export const User = mongoose.model('User', userSchema);
