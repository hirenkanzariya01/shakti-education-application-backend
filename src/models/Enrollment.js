const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const enrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    enrolledBy: { type: String, enum: ['self', 'admin'], default: 'self' },
  },
  { timestamps: true }
);
enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
enrollmentSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Enrollment', enrollmentSchema);
